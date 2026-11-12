import type { LedgerAccountType } from '../generated/prisma/enums.ts';
import type { Tx } from '../db.ts';

/** Stable account codes. Everything money-related posts to one of these or a per-business receivable. */
export const ACCOUNTS = {
  /** Cash in the funding pool that fronts landlord payouts. Asset. */
  CAPITAL_POOL: 'capital_pool',
  /** Operating cash collected from businesses, before it is swept back to the pool. Asset. */
  CASH: 'cash',
  /** Fees earned by CashFlow. Revenue. */
  FEE_REVENUE: 'fee_revenue',
  /** Where the pool's money came from (investors, a credit facility). Equity. */
  POOL_EQUITY: 'pool_equity',
  /**
   * Allowance for credit losses: the part of receivables not expected to be repaid. A contra
   * asset: typed ASSET with a credit balance, so its natural balance reads negative and
   * receivables plus the allowance is the net receivable. Built by the provision job,
   * drawn down by charge-offs.
   */
  ALLOWANCE: 'allowance:credit_losses',
  /** Cost of building the allowance. Expense. */
  PROVISION_EXPENSE: 'provision_expense',
  /** Payments received on balances already written off. Revenue. */
  RECOVERY_INCOME: 'recovery_income',
  /**
   * Rent a business has paid CashFlow on a pass-through plan and CashFlow has not yet paid
   * on to the landlord. Liability: money held for someone else, never CashFlow's own.
   */
  LANDLORD_PAYABLE: 'landlord_payable',
  /**
   * The cash behind `landlord_payable`: pass-through collections held until the landlord is
   * paid. Asset. Kept apart from operating `cash` so the daily sweep never moves a
   * business's rent into the capital pool.
   */
  PASS_THROUGH_CASH: 'pass_through_cash',
} as const;

export const SYSTEM_ACCOUNTS: ReadonlyArray<{
  code: string;
  name: string;
  type: LedgerAccountType;
}> = [
  { code: ACCOUNTS.CAPITAL_POOL, name: 'Capital pool', type: 'ASSET' },
  { code: ACCOUNTS.CASH, name: 'Operating cash', type: 'ASSET' },
  { code: ACCOUNTS.FEE_REVENUE, name: 'Fee revenue', type: 'REVENUE' },
  { code: ACCOUNTS.POOL_EQUITY, name: 'Pool capital', type: 'EQUITY' },
  { code: ACCOUNTS.ALLOWANCE, name: 'Allowance for credit losses', type: 'ASSET' },
  { code: ACCOUNTS.PROVISION_EXPENSE, name: 'Provision for credit losses', type: 'EXPENSE' },
  { code: ACCOUNTS.RECOVERY_INCOME, name: 'Recoveries on charged off balances', type: 'REVENUE' },
  { code: ACCOUNTS.LANDLORD_PAYABLE, name: 'Rent payable to landlords', type: 'LIABILITY' },
  {
    code: ACCOUNTS.PASS_THROUGH_CASH,
    name: 'Pass-through rent held for landlords',
    type: 'ASSET',
  },
];

/** Prefix shared by every per business receivable account. */
export const RECEIVABLE_PREFIX = 'receivable:';

export function receivableCode(businessId: string): string {
  return `receivable:${businessId}`;
}

export async function ensureSystemAccounts(tx: Tx): Promise<void> {
  for (const account of SYSTEM_ACCOUNTS) {
    await tx.ledgerAccount.upsert({
      where: { code: account.code },
      update: {},
      create: account,
    });
  }
}

export async function ensureReceivableAccount(tx: Tx, businessId: string, businessName: string) {
  return tx.ledgerAccount.upsert({
    where: { code: receivableCode(businessId) },
    update: {},
    create: {
      code: receivableCode(businessId),
      name: `Receivable: ${businessName}`,
      type: 'ASSET',
      ownerType: 'business',
      ownerId: businessId,
    },
  });
}
