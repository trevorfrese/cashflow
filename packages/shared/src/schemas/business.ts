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

/** Last four digits of the business tax id (EIN). The full number is never collected. */
export const TaxIdLast4 = z.string().regex(/^\d{4}$/, 'Enter the last 4 digits');

/**
 * A person who owns or controls the business. Name, title and ownership share only: no date
 * of birth and no government id number is collected or stored.
 */
export const BeneficialOwnerInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  /** Role in the business, for example "Owner" or "Managing member". */
  title: z.string().trim().min(1).max(80),
  /** Ownership share in basis points: 2500 is 25%. */
  ownershipBps: z.number().int().min(1, 'Ownership must be above zero').max(10_000),
});
export type BeneficialOwnerInput = z.infer<typeof BeneficialOwnerInput>;

/** At least one owner, at most ten, and shares that add up to no more than 100%. */
export const BeneficialOwnersInput = z
  .array(BeneficialOwnerInput)
  .min(1, 'Add at least one owner')
  .max(10)
  .refine((owners) => owners.reduce((sum, o) => sum + o.ownershipBps, 0) <= 10_000, {
    message: 'Ownership shares add up to more than 100%',
  });

export const BeneficialOwner = BeneficialOwnerInput.extend({ id: Id });
export type BeneficialOwner = z.infer<typeof BeneficialOwner>;

/**
 * What the owner is told about verification. Three states and plain words: the provider's
 * reasons and any screening detail stay internal.
 *
 *   VERIFIED      nothing to do
 *   NEEDS_INFO    details are missing (a tax id, an owner). `message` says what to add
 *   UNDER_REVIEW  our team is looking at the account. `message` says to contact support
 */
export const BusinessVerification = z.object({
  status: z.enum(['VERIFIED', 'NEEDS_INFO', 'UNDER_REVIEW']),
  message: z.string().nullable(),
});
export type BusinessVerification = z.infer<typeof BusinessVerification>;

const BusinessFields = z.object({
  legalName: z.string().min(1).max(200),
  dba: z.string().max(200).optional(),
  industry: Industry,
  address: Address,
  /** First month the business was operating. */
  foundedOn: IsoDateSchema,
  statedMonthlyRevenueCents: Cents,
});

export const CreateBusinessRequest = BusinessFields.extend({
  taxIdLast4: TaxIdLast4,
  owners: BeneficialOwnersInput,
});
export type CreateBusinessRequest = z.infer<typeof CreateBusinessRequest>;

/** Any subset. `owners`, when given, replaces the whole list. */
export const UpdateBusinessRequest = CreateBusinessRequest.partial();
export type UpdateBusinessRequest = z.infer<typeof UpdateBusinessRequest>;

export const Business = BusinessFields.extend({
  id: Id,
  ownerUserId: Id,
  status: BusinessStatus,
  /** Null on a business created before identity verification existed. */
  taxIdLast4: TaxIdLast4.nullable(),
  owners: z.array(BeneficialOwner),
  verification: BusinessVerification,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Business = z.infer<typeof Business>;
