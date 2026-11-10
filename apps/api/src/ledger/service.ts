import type { AccountBalance, TrialBalance } from '@cashflow/shared';

import type { Tx } from '../db.ts';
import { naturalBalance, validateEntries, type EntryInput } from './validate.ts';

export interface PostTransactionInput {
  description: string;
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
