import { z } from 'zod';

import { BankLinkStatus, ConnectionAccessMethod, ConnectionHealth } from '../enums';
import { Cents, Id, IsoDateTimeSchema } from './common';

export const CreateBankLinkRequest = z.object({
  businessId: Id,
  /**
   * Provider specific token. For the mock provider any string works and a fake
   * institution is returned. For Plaid this would be the public token from Link.
   */
  publicToken: z.string().min(1),
});
export type CreateBankLinkRequest = z.infer<typeof CreateBankLinkRequest>;

export const BankLink = z.object({
  id: Id,
  businessId: Id,
  provider: z.string(),
  institutionName: z.string(),
  accountMask: z.string(),
  status: BankLinkStatus,
  /** Latest observed available balance, if the provider reports one. */
  availableBalanceCents: Cents.nullable(),
  /** How the data is obtained: always an aggregator for a bank. */
  accessMethod: ConnectionAccessMethod.default('AGGREGATOR'),
  health: ConnectionHealth.default('HEALTHY'),
  createdAt: IsoDateTimeSchema,
});
export type BankLink = z.infer<typeof BankLink>;
