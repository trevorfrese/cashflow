import type { AccountBalance, IsoDate, TrialBalance } from '@cashflow/shared';

import type { Tx } from '../db.ts';
import { ACCOUNTS, RECEIVABLE_PREFIX } from './accounts.ts';
import { naturalBalance, validateEntries, type EntryInput } from './validate.ts';

export interface PostTransactionInput {
  description: string;
  /**
   * The calendar date the movement belongs to: the job's as-of date, or today for a request.
   * `postedAt` records when the row was written, so replayed history keeps both.
   */
  effectiveDate: IsoDate;
  referenceType?: string;
  referenceId?: string;
  /** Prevents double posting for the same business event. Strongly recommended. */
  idempotencyKey?: string;
  entries: EntryInput[];
}

/**
 * Posts a balanced double-entry transaction. Must be called inside a database transaction
 * together with the state change it records, so both commit or neither does.
 * If `idempotencyKey` was already posted, returns the existing transaction and posts nothing.
 */
export async function postTransaction(tx: Tx, input: PostTransactionInput) {
  validateEntries(input.entries);

  if (input.idempotencyKey) {
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) return existing;
  }

  const codes = [...new Set(input.entries.map((e) => e.accountCode))];
  const accounts = await tx.ledgerAccount.findMany({ where: { code: { in: codes } } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const code of codes) {
    if (!byCode.has(code)) throw new Error(`Unknown ledger account: ${code}`);
  }

  return tx.ledgerTransaction.create({
    data: {
      description: input.description,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      effectiveDate: input.effectiveDate,
      entries: {
        create: input.entries.map((e) => ({
          accountId: byCode.get(e.accountCode)!.id,
          direction: e.direction,
          amountCents: e.amountCents,
        })),
      },
    },
    include: { entries: true },
  });
}

async function sumsFor(
  tx: Tx,
  accountId: string,
): Promise<{ debitsCents: number; creditsCents: number }> {
  const grouped = await tx.ledgerEntry.groupBy({
    by: ['direction'],
    where: { accountId },
    _sum: { amountCents: true },
  });
  let debitsCents = 0;
  let creditsCents = 0;
  for (const g of grouped) {
    if (g.direction === 'DEBIT') debitsCents = g._sum.amountCents ?? 0;
    else creditsCents = g._sum.amountCents ?? 0;
  }
  return { debitsCents, creditsCents };
}

/** Natural balance of one account by code. Zero if the account does not exist yet. */
export async function accountBalance(tx: Tx, code: string): Promise<number> {
  const account = await tx.ledgerAccount.findUnique({ where: { code } });
  if (!account) return 0;
  const { debitsCents, creditsCents } = await sumsFor(tx, account.id);
  return naturalBalance(account.type, debitsCents, creditsCents);
}

/** A posted transaction with its entries and their account codes, or null. */
export function findTransactionByKey(tx: Tx, idempotencyKey: string) {
  return tx.ledgerTransaction.findUnique({
    where: { idempotencyKey },
    include: { entries: { include: { account: { select: { code: true } } } } },
  });
}

/**
 * Posts the mirror image of an earlier transaction: every debit becomes a credit and every
 * credit a debit. Ledger rows are append-only, so this is how a returned payment is undone.
 * Idempotent on `idempotencyKey`. Throws if the original was never posted.
 */
export async function reverseTransaction(
  tx: Tx,
  originalKey: string,
  input: Omit<PostTransactionInput, 'entries'> & { idempotencyKey: string },
) {
  const original = await findTransactionByKey(tx, originalKey);
  if (!original) throw new Error(`No ledger transaction to reverse: ${originalKey}`);
  return postTransaction(tx, {
    ...input,
    entries: original.entries.map((e) => ({
      accountCode: e.account.code,
      direction: e.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      amountCents: e.amountCents,
    })),
  });
}

/** Sum of every per business receivable account: principal owed and not written off. */
export async function receivablesBalance(tx: Tx): Promise<number> {
  const grouped = await tx.ledgerEntry.groupBy({
    by: ['direction'],
    where: { account: { code: { startsWith: RECEIVABLE_PREFIX } } },
    _sum: { amountCents: true },
  });
  return grouped.reduce(
    (sum, row) => sum + (row.direction === 'DEBIT' ? 1 : -1) * (row._sum.amountCents ?? 0),
    0,
  );
}

/** The allowance for credit losses as a positive number (it is a contra asset). */
export async function allowanceBalance(tx: Tx): Promise<number> {
  const natural = await accountBalance(tx, ACCOUNTS.ALLOWANCE);
  return natural === 0 ? 0 : -natural;
}

export async function trialBalance(tx: Tx): Promise<TrialBalance> {
  const accounts = await tx.ledgerAccount.findMany({ orderBy: { code: 'asc' } });
  const rows: AccountBalance[] = [];
  let totalDebitsCents = 0;
  let totalCreditsCents = 0;
  for (const account of accounts) {
    const { debitsCents, creditsCents } = await sumsFor(tx, account.id);
    totalDebitsCents += debitsCents;
    totalCreditsCents += creditsCents;
    rows.push({
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        ownerType: account.ownerType,
        ownerId: account.ownerId,
      },
      debitsCents,
      creditsCents,
      balanceCents: naturalBalance(account.type, debitsCents, creditsCents),
    });
  }
  return {
    accounts: rows,
    totalDebitsCents,
    totalCreditsCents,
    balanced: totalDebitsCents === totalCreditsCents,
  };
}
