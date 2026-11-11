/**
 * Builders for demo businesses. The seed (`prisma/seed.ts`) and the dev tools both build
 * personas through these, so a persona rebuilt from the dev menu is made by the same code
 * that made it in the seed.
 *
 * Each builder writes rows the way the product would (bank link exchange, a real
 * underwriting run, `createRentPlan`) and fails loudly if the engine told a different story
 * from the one the persona is for.
 */
import {
  addDays,
  dueDateInMonth,
  parseIsoDate,
  type CommercePlatform,
  type IsoDate,
} from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { BankLink, Business, CommerceLink } from '../generated/prisma/client.ts';
import type { Industry } from '../generated/prisma/enums.ts';
import {
  completeOAuth,
  connectBank,
  createSeatInvitation,
  mockAuthorize,
  startOAuth,
  verifySeat,
} from '../services/connections.ts';
import { currentDecision } from '../services/decisions.ts';
import { createRentPlan } from '../services/rent-plan.ts';
import { underwriteApplication } from '../services/underwriting.ts';

/** The first of the month `n` months before `from`. */
export function monthsAgo(n: number, from: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(from);
  const total = year * 12 + (month - 1) - n;
  return dueDateInMonth(Math.floor(total / 12), (total % 12) + 1, 1);
}

/** The same day of the month, `n` months earlier. Only used with days 1 to 28. */
export function monthsBefore(date: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const total = year * 12 + (month - 1) - n;
  return dueDateInMonth(Math.floor(total / 12), (total % 12) + 1, day);
}

export interface OwnerSeed {
  fullName: string;
  title: string;
}

export interface BusinessSeed {
  legalName: string;
  dba?: string;
  industry: Industry;
  addressLine1: string;
  postalCode: string;
  foundedOn: string;
  monthlyRevenueCents: number;
  taxIdLast4: string;
  owner: OwnerSeed;
}

/** A business profile with one owner holding all of it. */
export function createBusiness(
  ctx: AppContext,
  userId: string,
  seed: BusinessSeed,
  options: { status?: 'ONBOARDING' | 'ACTIVE'; createdAt?: Date } = {},
): Promise<Business> {
  return ctx.db.business.create({
    data: {
      ownerUserId: userId,
      legalName: seed.legalName,
      dba: seed.dba,
      industry: seed.industry,
      addressLine1: seed.addressLine1,
      city: 'Portland',
      state: 'OR',
      postalCode: seed.postalCode,
      foundedOn: seed.foundedOn,
      statedMonthlyRevenueCents: seed.monthlyRevenueCents,
      taxIdLast4: seed.taxIdLast4,
      owners: { create: [{ ...seed.owner, ownershipBps: 10_000 }] },
      ...(options.status ? { status: options.status } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

/** Exchange a sandbox public token and store the link, as `POST /v1/bank-links` does. */
export async function linkBank(
  ctx: AppContext,
  businessId: string,
  publicToken: string,
  createdAt?: Date,
): Promise<{ bankLink: BankLink; accountToken: string }> {
  const bankLink = await connectBank(ctx, {
    businessId,
    publicToken,
    ...(createdAt ? { createdAt } : {}),
  });
  return { bankLink, accountToken: bankLink.providerAccountToken };
}

/**
 * Connect a sandbox point of sale the way the app does: start an OAuth authorization, approve
 * it on the sandbox consent page with the token's keywords, and complete the callback. Toast
 * goes through a delegated seat invitation and its check instead.
 */
export async function linkPointOfSale(
  ctx: AppContext,
  businessId: string,
  publicToken: string,
  platform: CommercePlatform = 'SQUARE',
): Promise<CommerceLink> {
  const business = await ctx.db.business.findUniqueOrThrow({ where: { id: businessId } });
  const userId = business.ownerUserId;
  if (ctx.providers.commerce.accessMethod(platform) === 'DELEGATED_SEAT') {
    const { link } = await createSeatInvitation(ctx, {
      businessId,
      platform,
      scenario: publicToken,
      userId,
    });
    return verifySeat(ctx, link.id);
  }
  const started = await startOAuth(ctx, {
    businessId,
    userId,
    platform,
    redirectUri: ctx.config.OAUTH_REDIRECT_URI,
  });
  const approved = await mockAuthorize(ctx, {
    state: started.state,
    userId,
    scenario: publicToken,
    approve: true,
  });
  return completeOAuth(ctx, { state: started.state, userId, code: approved.code! });
}

export interface ApplySeed {
  businessId: string;
  bankLink: BankLink | null;
  commerceLink?: CommerceLink | null;
  monthlyRevenueCents: number;
  timeInBusinessMonths: number;
  rentCents: number;
  /** The day the application is decided. Today when left out. */
  asOf?: IsoDate;
  /** When the draft was created. Now when left out. */
  createdAt?: Date;
}

/** Create an application and run underwriting on it. Returns the application as decided. */
export async function apply(ctx: AppContext, seed: ApplySeed) {
  const draft = await ctx.db.underwritingApplication.create({
    data: {
      businessId: seed.businessId,
      bankLinkId: seed.bankLink?.id,
      commerceLinkId: seed.commerceLink?.id,
      statedMonthlyRevenueCents: seed.monthlyRevenueCents,
      timeInBusinessMonths: seed.timeInBusinessMonths,
      requestedMonthlyRentCents: seed.rentCents,
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
  return underwriteApplication({
    db: ctx.db,
    providers: ctx.providers,
    applicationId: draft.id,
    bankLink: seed.bankLink,
    commerceLink: seed.commerceLink ?? null,
    ...(seed.asOf ? { asOf: seed.asOf } : {}),
  });
}

export interface LeaseSeed {
  businessId: string;
  landlordName: string;
  landlordPayoutToken: string;
  addressLine1: string;
  postalCode: string;
  rentCents: number;
  dueDayOfMonth: number;
  startsOn: IsoDate;
}

export function createLease(ctx: AppContext, seed: LeaseSeed) {
  return ctx.db.lease.create({
    data: {
      businessId: seed.businessId,
      landlordName: seed.landlordName,
      landlordEmail: 'leases@example.com',
      propertyLine1: seed.addressLine1,
      propertyCity: 'Portland',
      propertyState: 'OR',
      propertyPostalCode: seed.postalCode,
      monthlyRentCents: seed.rentCents,
      dueDayOfMonth: seed.dueDayOfMonth,
      startsOn: seed.startsOn,
      landlordAccountHolderName: `${seed.landlordName} LLC`,
      landlordRoutingNumber: '123456789',
      landlordAccountNumberLast4: seed.landlordPayoutToken.length.toString().padStart(4, '4'),
      landlordPayoutToken: seed.landlordPayoutToken,
    },
  });
}

export interface PlanSeed extends BusinessSeed {
  timeInBusinessMonths: number;
  rentCents: number;
  dueDayOfMonth: number;
  /** The plan is opened as of this date; its first rent date is the next due day. */
  planStart: IsoDate;
  bankToken: string;
  posToken?: string;
  landlordName: string;
  landlordPayoutToken: string;
}

/** A business that is approved on healthy data and opens a plan as of `planStart`. */
export async function seedPlan(ctx: AppContext, userId: string, seed: PlanSeed) {
  const business = await createBusiness(ctx, userId, seed, {
    status: 'ACTIVE',
    // Signed up shortly before the plan opened, not today.
    createdAt: effectiveAt(addDays(seed.planStart, -2)),
  });
  const { bankLink, accountToken } = await linkBank(ctx, business.id, seed.bankToken);
  const commerceLink = seed.posToken
    ? await linkPointOfSale(ctx, business.id, seed.posToken)
    : null;
  // Decided as of the day of the build, not `planStart`: the sandbox bank's history is
  // anchored on today, and the decision is not part of the replayed story.
  const application = await apply(ctx, {
    businessId: business.id,
    bankLink,
    commerceLink,
    monthlyRevenueCents: seed.monthlyRevenueCents,
    timeInBusinessMonths: seed.timeInBusinessMonths,
    rentCents: seed.rentCents,
    createdAt: effectiveAt(addDays(seed.planStart, -1)),
  });
  if (application.status !== 'APPROVED') {
    throw new Error(`Expected ${seed.legalName} to be approved, got ${application.status}`);
  }
  const lease = await createLease(ctx, {
    businessId: business.id,
    landlordName: seed.landlordName,
    landlordPayoutToken: seed.landlordPayoutToken,
    addressLine1: seed.addressLine1,
    postalCode: seed.postalCode,
    rentCents: seed.rentCents,
    dueDayOfMonth: seed.dueDayOfMonth,
    startsOn: seed.planStart,
  });
  const plan = await createRentPlan(ctx, {
    userId,
    leaseId: lease.id,
    applicationId: application.id,
    installmentsPerMonth: 2,
    asOf: seed.planStart,
  });
  return { business, bankLink, lease, plan, goodToken: accountToken };
}

export interface ReferredSeed extends BusinessSeed {
  rentCents: number;
  bankToken: string;
  /** The day the application is submitted. */
  appliedOn: IsoDate;
}

/**
 * A business with healthy cash flow whose application is referred by identity or screening.
 * Fails if the engine did anything but refer it.
 */
export async function seedReferred(ctx: AppContext, userId: string, seed: ReferredSeed) {
  const at = effectiveAt(seed.appliedOn);
  const business = await createBusiness(ctx, userId, seed, { createdAt: at });
  const { bankLink } = await linkBank(ctx, business.id, seed.bankToken, at);
  const application = await apply(ctx, {
    businessId: business.id,
    bankLink,
    monthlyRevenueCents: seed.monthlyRevenueCents,
    timeInBusinessMonths: 80,
    rentCents: seed.rentCents,
    asOf: seed.appliedOn,
    createdAt: at,
  });
  if (application.status !== 'IN_REVIEW') {
    throw new Error(`Expected ${seed.legalName} to be referred, got ${application.status}`);
  }
  return { business, application };
}

/** The approved limit on an application's current decision, or null. */
export async function approvedLimitCents(
  ctx: AppContext,
  applicationId: string,
): Promise<number | null> {
  const decision = await currentDecision(ctx.db, applicationId);
  return decision?.outcome === 'APPROVED' ? decision.approvedMonthlyLimitCents : null;
}
