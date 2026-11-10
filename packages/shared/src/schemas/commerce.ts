import { z } from 'zod';

import { BankLinkStatus } from '../enums';
import { Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Point of sale and commerce platforms a business can connect. Sales data from the platform
 * verifies revenue at the source, before deposits are batched, netted, or held in reserve.
 */
export const CommercePlatform = z.enum(['SQUARE', 'TOAST', 'SHOPIFY', 'CLOVER', 'STRIPE']);
export type CommercePlatform = z.infer<typeof CommercePlatform>;

export const COMMERCE_PLATFORM_LABELS: Record<CommercePlatform, string> = {
  SQUARE: 'Square',
  TOAST: 'Toast',
  SHOPIFY: 'Shopify',
  CLOVER: 'Clover',
  STRIPE: 'Stripe',
};

/** One day of sales as the platform reports it. Amounts are gross of the platform's fees. */
export const DailySales = z.object({
  date: IsoDateSchema,
  grossCents: Cents,
  refundsCents: Cents,
  chargebacksCents: Cents,
  orderCount: z.number().int().min(0),
  /** Share of gross sales paid by card, in basis points. The rest is cash or other. */
  cardShareBps: z.number().int().min(0).max(10_000),
});
export type DailySales = z.infer<typeof DailySales>;

/**
 * Features the engine derives from platform sales. Stored with the decision next to the
 * bank features so a decision can be explained later.
 */
export const CommerceSummary = z.object({
  platform: CommercePlatform,
  monthsOfHistory: z.number().int().min(0),
  monthsOnPlatform: z.number().int().min(0),
  /** Mean net sales (gross less refunds and chargebacks) over the last three full months. */
  verifiedMonthlySalesCents: Cents,
  salesDaysPerMonth: z.number().min(0),
  refundRateBps: z.number().int().min(0),
  chargebackRateBps: z.number().int().min(0),
  /** Last three months versus the prior three. */
  trendBps: z.number().int(),
  /** Coefficient of variation of monthly net sales. */
  volatilityBps: z.number().int().min(0),
  /**
   * Bank operating inflows as a share of platform net sales over the same months. Near
   * 10000 means the two sources agree. Null when there is no bank data to compare.
   */
  depositMatchBps: z.number().int().min(0).nullable(),
});
export type CommerceSummary = z.infer<typeof CommerceSummary>;

export const CreateCommerceLinkRequest = z.object({
  businessId: Id,
  platform: CommercePlatform,
  /**
   * Provider specific token. For the mock provider any string works and the same scenario
   * keywords as the sandbox bank apply (`healthy`, `declining`, `sales_40000`, ...).
   */
  publicToken: z.string().min(1),
});
export type CreateCommerceLinkRequest = z.infer<typeof CreateCommerceLinkRequest>;

export const CommerceLink = z.object({
  id: Id,
  businessId: Id,
  provider: z.string(),
  platform: CommercePlatform,
  locationName: z.string(),
  status: BankLinkStatus,
  /** When the business started selling on the platform, as the platform reports it. */
  connectedSince: IsoDateSchema,
  createdAt: IsoDateTimeSchema,
});
export type CommerceLink = z.infer<typeof CommerceLink>;
