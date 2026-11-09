import { z } from 'zod';

import { LedgerAccountType, LedgerDirection } from '../enums';
import { Cents, Id, IsoDateTimeSchema } from './common';

export const LedgerAccount = z.object({
  id: Id,
  code: z.string(),
  name: z.string(),
  type: LedgerAccountType,
  ownerType: z.string().nullable(),
  ownerId: Id.nullable(),
});
export type LedgerAccount = z.infer<typeof LedgerAccount>;

export const LedgerEntry = z.object({
  id: Id,
  transactionId: Id,
  accountId: Id,
  direction: LedgerDirection,
  amountCents: Cents,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const LedgerTransaction = z.object({
  id: Id,
  description: z.string(),
  referenceType: z.string().nullable(),
  referenceId: Id.nullable(),
  postedAt: IsoDateTimeSchema,
  entries: z.array(LedgerEntry),
});
export type LedgerTransaction = z.infer<typeof LedgerTransaction>;

export const AccountBalance = z.object({
  account: LedgerAccount,
  debitsCents: Cents,
  creditsCents: Cents,
  /** Signed natural balance: positive for debit-normal accounts with a debit balance, and so on. */
  balanceCents: z.number().int(),
});
export type AccountBalance = z.infer<typeof AccountBalance>;

export const TrialBalance = z.object({
  accounts: z.array(AccountBalance),
  totalDebitsCents: Cents,
  totalCreditsCents: Cents,
  balanced: z.boolean(),
});
export type TrialBalance = z.infer<typeof TrialBalance>;
