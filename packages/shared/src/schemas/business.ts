import { z } from 'zod';

import { BusinessStatus } from '../enums';
import { Address, Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

export const Industry = z.enum([
  'RESTAURANT',
  'RETAIL',
  'SALON',
  'FITNESS',
  'PROFESSIONAL_SERVICES',
  'HEALTHCARE',
  'OTHER',
]);
export type Industry = z.infer<typeof Industry>;

export const CreateBusinessRequest = z.object({
  legalName: z.string().min(1).max(200),
  dba: z.string().max(200).optional(),
  industry: Industry,
  address: Address,
  /** First month the business was operating. */
  foundedOn: IsoDateSchema,
  statedMonthlyRevenueCents: Cents,
});
export type CreateBusinessRequest = z.infer<typeof CreateBusinessRequest>;

export const UpdateBusinessRequest = CreateBusinessRequest.partial();
export type UpdateBusinessRequest = z.infer<typeof UpdateBusinessRequest>;

export const Business = CreateBusinessRequest.extend({
  id: Id,
  ownerUserId: Id,
  status: BusinessStatus,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Business = z.infer<typeof Business>;
