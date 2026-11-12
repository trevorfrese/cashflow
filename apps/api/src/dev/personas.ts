/**
 * The persona registry: every account the dev menu can sign in as, in one file.
 *
 * A persona is a key, what it demonstrates, the screens worth visiting, and a deterministic
 * builder. To add one, append a definition to `PERSONAS` below. The seed, the dev routes,
 * the app's dev menu, the CLI and the dev home page all read this list; nothing else needs
 * to know the persona exists. `AGENTS.md` has the checklist.
 *
 * Three kinds of builder:
 *
 *   fresh     Only the login exists. The persona carries a `walkthrough`: the inputs the
 *             app prefills during onboarding so the decision comes out a chosen way.
 *   instant   Built in one step on the day it is asked for: a business, a bank link, and a
 *             real underwriting run. No ledger postings.
 *   history   A plan opened months ago and brought to today by replaying the jobs one day
 *             at a time. The replay runs for the whole book, so these are only built by a
 *             full reset (`seedDemoData`), never one at a time.
 */
import type { DevLandingScreen, DevPersonaGroup, DevWalkthrough } from '@cashflow/shared';
import { addDays, dueDateInMonth, parseIsoDate, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import { collectInstallment } from '../services/collections.ts';
import { updateLease } from '../services/lease-changes.ts';
import { ACTIVE_SERVICING_POLICY } from '../servicing/policy.ts';
import { createSeatInvitation } from '../services/connections.ts';
import { latestAssessment } from '../services/connection-views.ts';
import { passThroughOffer } from '../services/pass-through.ts';
import { reunderwritePlan } from '../services/reunderwriting.ts';
import {
  apply,
  approvedLimitCents,
  createBusiness,
  createLease,
  linkBank,
  linkPointOfSale,
  monthsAgo,
  monthsBefore,
  seedPassThrough,
  seedPlan,
  seedReferred,
} from './builders.ts';

/** Every persona account signs in with this. Sandbox data only. */
export const PERSONA_PASSWORD = 'demo-password-123';

export interface BuildArgs {
  ctx: AppContext;
  /** The persona's user, already created. */
  userId: string;
  /** The date the build treats as today: the simulated date when the dev clock is ahead. */
  today: IsoDate;
}

/** A persona whose story is told by replaying the jobs over past dates. */
export interface HistoryScript {
  /** First day the replay has to cover for this persona. */
  replayFrom: IsoDate;
  /** Before the replay starts: create the business and open its plan in the past. */
  open(): Promise<void>;
  /** What happens to the business on `asOf`, before that day's jobs run. */
  beforeJobs(asOf: IsoDate): Promise<void>;
  /** After the replay: fail loudly if it told another story. */
  verify(): Promise<void>;
}

export type PersonaBuild =
  | { kind: 'fresh'; walkthrough: DevWalkthrough }
  | {
      kind: 'instant';
      /** The day the persona is built on, when that is not today. Used by the seed replay. */
      builtOn?: (today: IsoDate) => IsoDate;
      run(args: BuildArgs): Promise<void>;
    }
  | { kind: 'history'; script(args: BuildArgs): HistoryScript };

export interface PersonaDefinition {
  key: string;
  title: string;
  group: DevPersonaGroup;
  /** Sub heading inside the group. Personas with the same section are listed together. */
  section: string;
  demonstrates: string;
  screens: string[];
  email: string;
  /** The account holder's name. */
  fullName: string;
  landing: DevLandingScreen;
  build: PersonaBuild;
}

const dana = { fullName: 'Dana Rivera', title: 'Owner' };

/**
 * The rent day shared by the cycle shop and the florist: yesterday's day of the month (the
 * 28th at most), so their latest payout fell due yesterday at the latest and is still
 * inside the window in which a held payout can be released.
 */
function recentDue(today: IsoDate): { dueDay: number; lastDue: IsoDate } {
  const yesterday = parseIsoDate(addDays(today, -1));
  const dueDay = Math.min(28, yesterday.day);
  return { dueDay, lastDue: dueDateInMonth(yesterday.year, yesterday.month, dueDay) };
}

const setAccountToken = (ctx: AppContext, bankLinkId: string, token: string) =>
  ctx.db.bankLink.update({ where: { id: bankLinkId }, data: { providerAccountToken: token } });

// The preset bank tokens below were picked by running each through underwriting for every
// day of the next 200: the sandbox bank's history is anchored on today, so some tokens flip
// outcome on a few dates. These did not. `dev.int.test.ts` walks each preset on every run.
const freshBusiness = (b: {
  legalName: string;
  dba: string;
  industry: DevWalkthrough['business']['industry'];
  line1: string;
  postalCode: string;
  foundedOn: string;
  revenueCents: number;
  taxIdLast4: string;
  ownerName: string;
}): DevWalkthrough['business'] => ({
  legalName: b.legalName,
  dba: b.dba,
  industry: b.industry,
  address: { line1: b.line1, city: 'Portland', state: 'OR', postalCode: b.postalCode },
  foundedOn: b.foundedOn,
  statedMonthlyRevenueCents: b.revenueCents,
  taxIdLast4: b.taxIdLast4,
  owners: [{ fullName: b.ownerName, title: 'Owner', ownershipBps: 10_000 }],
});

export const PERSONAS: readonly PersonaDefinition[] = [
  // ---- Existing customers: plans ----
  {
    key: 'active-plan',
    title: 'Blue Door Bakery',
    group: 'CUSTOMER',
    section: 'Plans',
    demonstrates:
      'The happy path with history: approved, a $10,000 rent plan, three months paid on time, next month scheduled.',
    screens: ['Home', 'History', 'Settings, Rent'],
    email: 'demo@cashflow.local',
    fullName: 'Dana Rivera',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const planStart = monthsAgo(3, today);
        return {
          replayFrom: planStart,
          // It also connects its Square account, so its decision shows two sources.
          open: async () => {
            await seedPlan(ctx, userId, {
              legalName: 'Blue Door Bakery LLC',
              dba: 'Blue Door Bakery',
              industry: 'RESTAURANT',
              addressLine1: '412 Pine St',
              postalCode: '97204',
              foundedOn: '2021-03-01',
              monthlyRevenueCents: 6_000_000,
              timeInBusinessMonths: 68,
              rentCents: 1_000_000,
              dueDayOfMonth: 1,
              planStart,
              bankToken: 'seed_blue_door_healthy_rev_60000_rent_10000',
              posToken: 'seed_blue_door_square_healthy_sales_60000',
              landlordName: 'Harbor View Properties',
              landlordPayoutToken: 'mock_landlord_harbor_view',
              taxIdLast4: '4821',
              owner: dana,
            });
          },
          beforeJobs: async () => undefined,
          verify: async () => {
            const plan = await ctx.db.rentPlan.findFirstOrThrow({
              where: { business: { ownerUserId: userId } },
            });
            if (plan.status !== 'ACTIVE' || plan.delinquencyStatus !== 'CURRENT') {
              throw new Error(
                `Expected Blue Door Bakery to be active and current, got ${plan.status} ${plan.delinquencyStatus}`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'delinquent',
    title: 'Cedar Street Cycles',
    group: 'CUSTOMER',
    section: 'Plans',
    demonstrates:
      'Fell behind a month ago: debits fail, the plan is delinquent, and the latest landlord payout is held.',
    screens: ['Home (past due notice, held payout, Pay now)', 'History'],
    email: 'delinquent@cashflow.local',
    fullName: 'Dana Rivera',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const { dueDay, lastDue } = recentDue(today);
        const secondDue = monthsBefore(lastDue, 1);
        const firstDue = monthsBefore(lastDue, 2);
        let bankLinkId = '';
        let planId = '';
        return {
          replayFrom: addDays(firstDue, -3),
          open: async () => {
            const built = await seedPlan(ctx, userId, {
              legalName: 'Cedar Street Cycles LLC',
              dba: 'Cedar Street Cycles',
              industry: 'RETAIL',
              addressLine1: '1530 SE Cedar St',
              postalCode: '97214',
              foundedOn: '2020-06-01',
              monthlyRevenueCents: 5_200_000,
              timeInBusinessMonths: 60,
              rentCents: 480_000,
              dueDayOfMonth: dueDay,
              planStart: addDays(firstDue, -3),
              bankToken: 'seed_cedar_cycles_healthy_rev_52000_rent_4800',
              landlordName: 'Eastside Commercial',
              landlordPayoutToken: 'mock_landlord_eastside',
              taxIdLast4: '7310',
              owner: dana,
            });
            bankLinkId = built.bankLink.id;
            planId = built.plan.id;
          },
          // Pays its first period and the first half of its second. Then its debits fail.
          beforeJobs: async (asOf) => {
            if (asOf === addDays(secondDue, 1)) {
              await setAccountToken(ctx, bankLinkId, 'mock_acct_cedar_fail');
            }
          },
          verify: async () => {
            const plan = await ctx.db.rentPlan.findUniqueOrThrow({
              where: { id: planId },
              include: { payouts: { where: { status: 'HELD' } } },
            });
            if (plan.delinquencyStatus !== 'DELINQUENT' || plan.payouts.length !== 1) {
              throw new Error(
                `Expected Cedar Street Cycles to be DELINQUENT with one held payout, got ${plan.delinquencyStatus} with ${plan.payouts.length}`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'charged-off',
    title: 'Juniper Print Studio',
    group: 'CUSTOMER',
    section: 'Plans',
    demonstrates:
      'Paid one month, missed the next, written off at 90 days past due. Plan closed, one of two written off payments recovered since.',
    screens: ['Home (written off balance, Pay now)', 'History'],
    email: 'charged-off@cashflow.local',
    fullName: 'Dana Rivera',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const firstDue = monthsAgo(5, today);
        const secondDue = monthsAgo(4, today);
        const chargeOff = addDays(secondDue, ACTIVE_SERVICING_POLICY.chargeOffAfterDays ?? 90);
        const recovery = addDays(chargeOff, 10);
        let bankLinkId = '';
        let planId = '';
        let goodToken = '';
        return {
          replayFrom: addDays(firstDue, -3),
          open: async () => {
            const built = await seedPlan(ctx, userId, {
              legalName: 'Juniper Print Studio LLC',
              dba: 'Juniper Print Studio',
              industry: 'PROFESSIONAL_SERVICES',
              addressLine1: '77 NW Juniper Ave',
              postalCode: '97209',
              foundedOn: '2019-09-01',
              monthlyRevenueCents: 4_400_000,
              timeInBusinessMonths: 72,
              rentCents: 390_000,
              dueDayOfMonth: 1,
              planStart: addDays(firstDue, -3),
              bankToken: 'seed_juniper_print_healthy_rev_44000_rent_3900',
              landlordName: 'Pearl District Holdings',
              landlordPayoutToken: 'mock_landlord_pearl',
              taxIdLast4: '2264',
              owner: dana,
            });
            bankLinkId = built.bankLink.id;
            planId = built.plan.id;
            goodToken = built.goodToken;
          },
          // Pays its first period. Both installments of the second fail and are written off.
          beforeJobs: async (asOf) => {
            if (asOf === addDays(secondDue, -1)) {
              await setAccountToken(ctx, bankLinkId, 'mock_acct_juniper_fail');
            }
            if (asOf === recovery) {
              // The owner comes back and pays the older of the two written off installments.
              await setAccountToken(ctx, bankLinkId, goodToken);
              const owed = await ctx.db.installment.findFirstOrThrow({
                where: { rentPlanId: planId, status: 'CHARGED_OFF' },
                orderBy: { dueDate: 'asc' },
              });
              const outcome = await collectInstallment(ctx, owed.id, asOf, { manual: true });
              if (outcome !== 'paid') throw new Error(`Expected a recovery, got ${outcome}`);
            }
          },
          verify: async () => {
            const plan = await ctx.db.rentPlan.findUniqueOrThrow({ where: { id: planId } });
            if (plan.status !== 'CLOSED' || plan.delinquencyStatus !== 'CHARGED_OFF') {
              throw new Error(
                `Expected Juniper Print Studio to be closed and charged off, got ${plan.status} ${plan.delinquencyStatus}`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'landlord-change',
    title: 'Alder & Ash Florist',
    group: 'CUSTOMER',
    section: 'Plans',
    demonstrates:
      'The landlord payout details were changed on the latest rent date. The change is in its cooling-off period and the payout is held.',
    screens: ['Home (held payout notice)', 'Settings, Rent'],
    email: 'landlord-change@cashflow.local',
    fullName: 'Sam Okafor',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const { dueDay, lastDue } = recentDue(today);
        const firstDue = monthsBefore(lastDue, 2);
        let leaseId = '';
        let planId = '';
        return {
          replayFrom: addDays(firstDue, -3),
          open: async () => {
            const built = await seedPlan(ctx, userId, {
              legalName: 'Alder & Ash Florist LLC',
              dba: 'Alder & Ash',
              industry: 'RETAIL',
              addressLine1: '904 NE Alberta St',
              postalCode: '97211',
              foundedOn: '2018-02-01',
              monthlyRevenueCents: 3_800_000,
              timeInBusinessMonths: 90,
              rentCents: 340_000,
              dueDayOfMonth: dueDay,
              planStart: addDays(firstDue, -3),
              bankToken: 'seed_alder_ash_healthy_rev_38000_rent_3400',
              landlordName: 'Alberta Arts Properties',
              landlordPayoutToken: 'mock_landlord_alberta_arts',
              taxIdLast4: '5507',
              owner: { fullName: 'Sam Okafor', title: 'Managing member' },
            });
            leaseId = built.lease.id;
            planId = built.plan.id;
          },
          beforeJobs: async (asOf) => {
            if (asOf !== lastDue) return;
            // On the morning rent is due, the landlord's bank details on the lease are
            // changed. It could be the owner or someone in the owner's account: either way
            // the change waits, the payout is held, and an alert opens.
            await updateLease(ctx, {
              leaseId,
              userId,
              asOf,
              body: {
                landlordPayout: {
                  accountHolderName: 'Alberta Arts Properties LLC',
                  routingNumber: '021000021',
                  accountNumberLast4: '9034',
                  providerToken: 'mock_landlord_alberta_arts_new_account',
                },
              },
            });
          },
          verify: async () => {
            const plan = await ctx.db.rentPlan.findUniqueOrThrow({
              where: { id: planId },
              include: { payouts: { where: { status: 'HELD' } } },
            });
            if (plan.payouts[0]?.heldReason !== 'LEASE_CHANGE_PENDING') {
              throw new Error(
                `Expected Alder & Ash to have a payout held by its lease change, got ${plan.payouts[0]?.heldReason ?? 'none held'}`,
              );
            }
          },
        };
      },
    },
  },

  // ---- Existing customers: pass-through ----
  {
    key: 'pass-through',
    title: 'Ridgeline Coffee',
    group: 'CUSTOMER',
    section: 'Pass-through',
    demonstrates:
      'Declined (five months in business), now on the free pass-through plan: rent collected five business days early, landlord paid on the due date, two months on time.',
    screens: ['Home (next collection, landlord paid)', 'History', 'Ops console, Customers'],
    email: 'pass-through@cashflow.local',
    fullName: 'Mara Lindqvist',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const { dueDay, lastDue } = recentDue(today);
        const firstDue = monthsBefore(lastDue, 1);
        const start = addDays(firstDue, -12);
        let planId = '';
        return {
          replayFrom: start,
          open: async () => {
            const built = await seedPassThrough(ctx, userId, {
              legalName: 'Ridgeline Coffee LLC',
              dba: 'Ridgeline Coffee',
              industry: 'RESTAURANT',
              addressLine1: '2510 SE Clinton St',
              postalCode: '97202',
              foundedOn: addDays(start, -150),
              monthlyRevenueCents: 4_000_000,
              taxIdLast4: '5530',
              owner: { fullName: 'Mara Lindqvist', title: 'Owner' },
              timeInBusinessMonths: 5,
              rentCents: 360_000,
              dueDayOfMonth: dueDay,
              start,
              bankToken: 'seed_ridgeline_healthy_rev_40000_rent_3600',
              landlordName: 'Clinton Street Partners',
              landlordPayoutToken: 'mock_landlord_clinton_street',
            });
            planId = built.plan.id;
          },
          beforeJobs: async () => undefined,
          verify: async () => {
            const paid = await ctx.db.passThroughPeriod.count({
              where: { rentPlanId: planId, status: 'PAID' },
            });
            const offers = await ctx.db.graduationOffer.count({
              where: { passThroughPlanId: planId },
            });
            if (paid !== 2 || offers !== 0) {
              throw new Error(
                `Expected Ridgeline Coffee to have two pass-through months paid and no offer, got ${paid} paid and ${offers} offers`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'pass-through-missed',
    title: 'Foundry Bike Works',
    group: 'CUSTOMER',
    section: 'Pass-through',
    demonstrates:
      'On the free pass-through plan: the first month was collected and paid, the second could not be collected, so CashFlow did not pay the landlord and told the owner to pay directly. No fee.',
    screens: ['Home (missed month notice)', 'History', 'Ops console, Customers'],
    email: 'pass-through-missed@cashflow.local',
    fullName: 'Theo Marchetti',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const { dueDay, lastDue } = recentDue(today);
        const firstDue = monthsBefore(lastDue, 1);
        const start = addDays(firstDue, -12);
        let planId = '';
        let bankLinkId = '';
        return {
          replayFrom: start,
          open: async () => {
            const built = await seedPassThrough(ctx, userId, {
              legalName: 'Foundry Bike Works LLC',
              dba: 'Foundry Bike Works',
              industry: 'RETAIL',
              addressLine1: '640 N Albina Ave',
              postalCode: '97227',
              foundedOn: addDays(start, -150),
              monthlyRevenueCents: 3_600_000,
              taxIdLast4: '6624',
              owner: { fullName: 'Theo Marchetti', title: 'Owner' },
              timeInBusinessMonths: 5,
              rentCents: 330_000,
              dueDayOfMonth: dueDay,
              start,
              bankToken: 'seed_foundry_healthy_rev_36000_rent_3300',
              landlordName: 'Albina Yards LLC',
              landlordPayoutToken: 'mock_landlord_albina_yards',
            });
            planId = built.plan.id;
            bankLinkId = built.bankLink.id;
          },
          // The second month's debits fail.
          beforeJobs: async (asOf) => {
            if (asOf === addDays(lastDue, -12)) {
              await setAccountToken(ctx, bankLinkId, 'mock_acct_foundry_fail');
            }
          },
          verify: async () => {
            const months = await ctx.db.passThroughPeriod.findMany({
              where: { rentPlanId: planId, status: { in: ['PAID', 'MISSED'] } },
              orderBy: { dueDate: 'asc' },
            });
            const statuses = months.map((m) => m.status).join(', ');
            if (statuses !== 'PAID, MISSED') {
              throw new Error(
                `Expected Foundry Bike Works to have one month paid then one missed, got ${statuses || 'none'}`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'graduation-offer',
    title: 'Willow & Wren Bakery',
    group: 'CUSTOMER',
    section: 'Pass-through',
    demonstrates:
      'Three months on time on the free pass-through plan. The refresh-eligibility job re-underwrote it with its payment history yesterday and offered a financed plan from the next rent month. Accept it on Home.',
    screens: ['Home (graduation offer, Accept)', 'Ops console, Customers'],
    email: 'graduation-offer@cashflow.local',
    fullName: 'Ines Ferreira',
    landing: 'HOME',
    build: {
      kind: 'history',
      script: ({ ctx, userId, today }) => {
        const { dueDay, lastDue } = recentDue(today);
        const firstDue = monthsBefore(lastDue, 2);
        const start = addDays(firstDue, -12);
        let planId = '';
        return {
          replayFrom: start,
          open: async () => {
            const built = await seedPassThrough(ctx, userId, {
              legalName: 'Willow & Wren Bakery LLC',
              dba: 'Willow & Wren',
              industry: 'RESTAURANT',
              addressLine1: '3725 N Mississippi Ave',
              postalCode: '97227',
              foundedOn: addDays(start, -150),
              monthlyRevenueCents: 4_500_000,
              taxIdLast4: '7718',
              owner: { fullName: 'Ines Ferreira', title: 'Owner' },
              timeInBusinessMonths: 5,
              rentCents: 400_000,
              dueDayOfMonth: dueDay,
              start,
              bankToken: 'seed_willow_wren_healthy_rev_45000_rent_4000',
              landlordName: 'Mississippi Avenue Holdings',
              landlordPayoutToken: 'mock_landlord_mississippi_ave',
            });
            planId = built.plan.id;
          },
          beforeJobs: async () => undefined,
          verify: async () => {
            const offer = await ctx.db.graduationOffer.findFirst({
              where: { passThroughPlanId: planId },
            });
            if (offer?.status !== 'OFFERED') {
              throw new Error(
                `Expected Willow & Wren to have an open graduation offer, got ${offer?.status ?? 'none'}`,
              );
            }
          },
        };
      },
    },
  },
  {
    key: 'pass-through-offer',
    title: 'Larkspur Tailoring',
    group: 'CUSTOMER',
    section: 'Pass-through',
    demonstrates:
      'Just declined (four months in business) with its lease linked. The decision offers the free pass-through plan: start it from the Application screen.',
    screens: ['Application (free plan offer, Start)', 'Home'],
    email: 'pass-through-offer@cashflow.local',
    fullName: 'Kofi Mensah',
    landing: 'APPLICATION',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId, today }) => {
        const business = await createBusiness(ctx, userId, {
          legalName: 'Larkspur Tailoring LLC',
          dba: 'Larkspur Tailoring',
          industry: 'RETAIL',
          addressLine1: '1407 NE Broadway',
          postalCode: '97232',
          foundedOn: addDays(today, -125),
          monthlyRevenueCents: 3_200_000,
          taxIdLast4: '3391',
          owner: { fullName: 'Kofi Mensah', title: 'Owner' },
        });
        const { bankLink } = await linkBank(
          ctx,
          business.id,
          'seed_larkspur_healthy_rev_32000_rent_3000',
        );
        const application = await apply(ctx, {
          businessId: business.id,
          bankLink,
          monthlyRevenueCents: 3_200_000,
          timeInBusinessMonths: 4,
          rentCents: 300_000,
        });
        if (application.status !== 'DECLINED') {
          throw new Error(`Expected Larkspur Tailoring to be declined, got ${application.status}`);
        }
        await createLease(ctx, {
          businessId: business.id,
          landlordName: 'Broadway Commons LLC',
          landlordPayoutToken: 'mock_landlord_broadway_commons',
          addressLine1: '1407 NE Broadway',
          postalCode: '97232',
          rentCents: 300_000,
          dueDayOfMonth: 1,
          startsOn: today,
        });
        const offer = await passThroughOffer(ctx.db, application.id);
        if (!offer.eligible) {
          throw new Error(
            `Expected Larkspur Tailoring to be offered a pass-through plan, got ${offer.ineligibleReason}`,
          );
        }
      },
    },
  },

  // ---- Existing customers: decisions ----
  {
    key: 'declined',
    title: 'Northside Barbers',
    group: 'CUSTOMER',
    section: 'Decisions',
    demonstrates:
      'Declined, with reasons: seven months old, repeated overdrafts, rent too high for its revenue.',
    screens: ['Home', 'Application (reasons, cash flow summary)'],
    email: 'declined@cashflow.local',
    fullName: 'Dana Rivera',
    landing: 'APPLICATION',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId, today }) => {
        const createdAt = effectiveAt(addDays(today, -12));
        const business = await createBusiness(
          ctx,
          userId,
          {
            legalName: 'Northside Barbers Inc',
            industry: 'SALON',
            addressLine1: '88 N Mississippi Ave',
            postalCode: '97227',
            foundedOn: monthsAgo(7, today),
            monthlyRevenueCents: 900_000,
            taxIdLast4: '3098',
            owner: dana,
          },
          { createdAt },
        );
        const { bankLink } = await linkBank(
          ctx,
          business.id,
          'seed_northside_overdrafts_rev_9000_rent_3500',
        );
        const application = await apply(ctx, {
          businessId: business.id,
          bankLink,
          monthlyRevenueCents: 900_000,
          timeInBusinessMonths: 7,
          rentCents: 350_000,
          createdAt,
        });
        if (application.status !== 'DECLINED') {
          throw new Error(`Expected Northside Barbers to be declined, got ${application.status}`);
        }
      },
    },
  },
  {
    key: 'needs-info',
    title: 'Lakeview Yoga',
    group: 'CUSTOMER',
    section: 'Decisions',
    demonstrates:
      'Applied without connecting a bank. The decision asks for one; connecting it finishes underwriting.',
    screens: ['Home', 'Application (Connect bank)'],
    email: 'needs-info@cashflow.local',
    fullName: 'Dana Rivera',
    landing: 'APPLICATION',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId }) => {
        const business = await createBusiness(ctx, userId, {
          legalName: 'Lakeview Yoga Collective LLC',
          dba: 'Lakeview Yoga',
          industry: 'FITNESS',
          addressLine1: '2200 SE Hawthorne Blvd',
          postalCode: '97214',
          foundedOn: '2022-09-01',
          monthlyRevenueCents: 2_100_000,
          taxIdLast4: '1175',
          owner: dana,
        });
        const application = await apply(ctx, {
          businessId: business.id,
          bankLink: null,
          monthlyRevenueCents: 2_100_000,
          timeInBusinessMonths: 50,
          rentCents: 380_000,
        });
        if (application.status !== 'NEEDS_INFO') {
          throw new Error(`Expected Lakeview Yoga to need info, got ${application.status}`);
        }
      },
    },
  },
  {
    key: 'manual-review',
    title: 'Tidewater Sign Works',
    group: 'CUSTOMER',
    section: 'Decisions',
    demonstrates:
      'Referred to a person 34 days ago (the tax id did not match) and never reviewed: past the 30 day decision deadline. Decide it in the ops console.',
    screens: ['Home (In review)', 'Application', 'Ops console, Reviews'],
    email: 'manual-review@cashflow.local',
    fullName: 'Priya Natarajan',
    landing: 'HOME',
    build: {
      kind: 'instant',
      builtOn: (today) => addDays(today, -34),
      run: async ({ ctx, userId, today }) => {
        // Tax id ending 0000: the sandbox identity provider cannot match it, so the
        // application is referred. Nobody reviews it.
        await seedReferred(ctx, userId, {
          legalName: 'Tidewater Sign Works LLC',
          dba: 'Tidewater Signs',
          industry: 'PROFESSIONAL_SERVICES',
          addressLine1: '3310 N Williams Ave',
          postalCode: '97227',
          foundedOn: '2019-04-01',
          monthlyRevenueCents: 4_100_000,
          rentCents: 360_000,
          bankToken: 'seed_tidewater_healthy_rev_41000_rent_3600',
          taxIdLast4: '0000',
          owner: { fullName: 'Priya Natarajan', title: 'Owner' },
          appliedOn: addDays(today, -34),
        });
      },
    },
  },
  {
    key: 'identity-review',
    title: 'Meridian Supply',
    group: 'CUSTOMER',
    section: 'Decisions',
    demonstrates:
      'An owner is a possible watchlist match. The application is held in review and nothing can be advanced until the hit is cleared in the ops console.',
    screens: ['Home (In review)', 'Application', 'Ops console, Screening'],
    email: 'identity-review@cashflow.local',
    fullName: 'Morgan Watchlist',
    landing: 'HOME',
    build: {
      kind: 'instant',
      builtOn: (today) => addDays(today, -2),
      run: async ({ ctx, userId, today }) => {
        // An owner whose name the sandbox screening provider reports as a possible match.
        await seedReferred(ctx, userId, {
          legalName: 'Meridian Supply Co LLC',
          dba: 'Meridian Supply',
          industry: 'RETAIL',
          addressLine1: '1218 SE Division St',
          postalCode: '97202',
          foundedOn: '2019-04-01',
          monthlyRevenueCents: 4_600_000,
          rentCents: 420_000,
          bankToken: 'seed_meridian_healthy_rev_46000_rent_4200',
          taxIdLast4: '6642',
          owner: { fullName: 'Morgan Watchlist', title: 'Owner' },
          appliedOn: addDays(today, -2),
        });
      },
    },
  },
  {
    key: 'counter-offer',
    title: 'Sellwood Books',
    group: 'CUSTOMER',
    section: 'Decisions',
    demonstrates:
      'Approved for less than the lease rent: asked for $6,000, approved for less. The lease is linked but the plan cannot start, because CashFlow funds a whole lease or nothing.',
    screens: ['Home (Start your rent plan)', 'Plan (refused: rent over limit)', 'Application'],
    email: 'counter-offer@cashflow.local',
    fullName: 'Robin Castellanos',
    landing: 'HOME',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId, today }) => {
        const rentCents = 600_000;
        const business = await createBusiness(ctx, userId, {
          legalName: 'Sellwood Books LLC',
          dba: 'Sellwood Books',
          industry: 'RETAIL',
          addressLine1: '7901 SE 13th Ave',
          postalCode: '97202',
          foundedOn: '2020-01-01',
          monthlyRevenueCents: 3_000_000,
          taxIdLast4: '8153',
          owner: { fullName: 'Robin Castellanos', title: 'Owner' },
        });
        const { bankLink } = await linkBank(ctx, business.id, 'seed_sellwood_healthy_rev_30000');
        const application = await apply(ctx, {
          businessId: business.id,
          bankLink,
          monthlyRevenueCents: 3_000_000,
          timeInBusinessMonths: 70,
          rentCents,
        });
        const limit = await approvedLimitCents(ctx, application.id);
        if (application.status !== 'APPROVED' || limit === null || limit >= rentCents) {
          throw new Error(
            `Expected Sellwood Books to be approved below its ${rentCents} cent rent, got ${application.status} with limit ${limit}`,
          );
        }
        await createLease(ctx, {
          businessId: business.id,
          landlordName: 'Sellwood Main Street Partners',
          landlordPayoutToken: 'mock_landlord_sellwood_main',
          addressLine1: '7901 SE 13th Ave',
          postalCode: '97202',
          rentCents,
          dueDayOfMonth: 1,
          startsOn: monthsAgo(0, today),
        });
      },
    },
  },

  // ---- Existing customers: data connections ----
  {
    key: 'payout-account',
    title: 'Fernwood Outfitters',
    group: 'CUSTOMER',
    section: 'Data connections',
    demonstrates:
      'An approved customer with an active plan who then connected Shopify, which pays out to a bank account that is not connected. The periodic review keeps the plan going and asks the owner to connect that account.',
    screens: ['Home (connect your payout account)', 'Connections', 'Ops console, Customers'],
    email: 'payout-account@cashflow.local',
    fullName: 'Lena Moreau',
    landing: 'CONNECTIONS',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId, today }) => {
        const { plan } = await seedPlan(ctx, userId, {
          legalName: 'Fernwood Outfitters LLC',
          dba: 'Fernwood Outfitters',
          industry: 'RETAIL',
          addressLine1: '3120 SE Belmont St',
          postalCode: '97214',
          foundedOn: '2019-05-01',
          monthlyRevenueCents: 4_200_000,
          timeInBusinessMonths: 78,
          rentCents: 380_000,
          dueDayOfMonth: 1,
          planStart: today,
          bankToken: 'seed_fernwood_healthy_rev_42000_rent_3800',
          posToken: 'seed_fernwood_square_healthy_sales_42000',
          landlordName: 'Belmont Street Partners',
          landlordPayoutToken: 'mock_landlord_belmont',
          taxIdLast4: '6105',
          owner: { fullName: 'Lena Moreau', title: 'Owner' },
        });
        // Later, an online store on Shopify, paying out to an account CashFlow cannot see.
        await linkPointOfSale(
          ctx,
          plan.businessId,
          'seed_fernwood_shopify_healthy_sales_42000_payout_elsewhere',
          'SHOPIFY',
        );
        const outcome = await reunderwritePlan(ctx, plan.id, today);
        const latest = await latestAssessment(ctx.db, plan.businessId);
        const codes = latest?.veracity.findings.map((f) => f.code) ?? [];
        if (outcome !== 'ok' || !codes.includes('PAYOUT_ACCOUNT_NOT_CONNECTED')) {
          throw new Error(
            `Expected Fernwood Outfitters' periodic review to pass and ask for the payout account, got ${outcome} with ${codes.join(', ') || 'no findings'}`,
          );
        }
      },
    },
  },
  {
    key: 'ownership-review',
    title: 'Pinecrest Ceramics',
    group: 'CUSTOMER',
    section: 'Data connections',
    demonstrates:
      'Referred because the bank reports the connected account as held by a different business. The owner is told only that the application is in review; the ops console shows the holder name and the evidence.',
    screens: ['Home (In review)', 'Connections', 'Ops console, Reviews'],
    email: 'ownership-review@cashflow.local',
    fullName: 'Tomas Novak',
    landing: 'HOME',
    build: {
      kind: 'instant',
      builtOn: (today) => addDays(today, -1),
      run: async ({ ctx, userId, today }) => {
        const { application } = await seedReferred(ctx, userId, {
          legalName: 'Pinecrest Ceramics LLC',
          dba: 'Pinecrest Ceramics',
          industry: 'RETAIL',
          addressLine1: '5525 NE 42nd Ave',
          postalCode: '97218',
          foundedOn: '2020-02-01',
          monthlyRevenueCents: 3_900_000,
          rentCents: 350_000,
          bankToken: 'seed_pinecrest_healthy_borrowed_rev_39000_rent_3500',
          taxIdLast4: '7741',
          owner: { fullName: 'Tomas Novak', title: 'Owner' },
          appliedOn: addDays(today, -1),
        });
        const decision = await ctx.db.underwritingDecision.findFirstOrThrow({
          where: { applicationId: application.id },
          orderBy: { decidedAt: 'desc' },
        });
        const triggers =
          (decision.snapshot as { referTriggers?: string[] } | null)?.referTriggers ?? [];
        if (!triggers.includes('VERACITY:BANK_OWNER_MISMATCH')) {
          throw new Error(
            `Expected Pinecrest Ceramics to be referred for the account holder, got ${triggers.join(', ') || 'no triggers'}`,
          );
        }
      },
    },
  },
  {
    key: 'toast-seat',
    title: 'Saltwater Taqueria',
    group: 'CUSTOMER',
    section: 'Data connections',
    demonstrates:
      "A Toast restaurant: Toast has no API to approve access through, so the owner is invited to add CashFlow's own read-only reports user. The seat is waiting: follow the steps, then Check connection.",
    screens: ['Connections (Toast instructions, Check connection)', 'Application'],
    email: 'toast-seat@cashflow.local',
    fullName: 'Ana Haddad',
    landing: 'CONNECTIONS',
    build: {
      kind: 'instant',
      run: async ({ ctx, userId }) => {
        const business = await createBusiness(ctx, userId, {
          legalName: 'Saltwater Taqueria LLC',
          dba: 'Saltwater Taqueria',
          industry: 'RESTAURANT',
          addressLine1: '2401 NE Alberta St',
          postalCode: '97211',
          foundedOn: '2018-07-01',
          monthlyRevenueCents: 5_000_000,
          taxIdLast4: '3390',
          owner: { fullName: 'Ana Haddad', title: 'Owner' },
        });
        await linkBank(ctx, business.id, 'seed_saltwater_healthy_rev_50000_rent_4500');
        const { link } = await createSeatInvitation(ctx, {
          businessId: business.id,
          platform: 'TOAST',
          scenario: 'healthy_sales_50000',
          userId,
        });
        if (link.status !== 'PENDING') {
          throw new Error(
            `Expected Saltwater Taqueria's Toast seat to be pending, got ${link.status}`,
          );
        }
      },
    },
  },

  // ---- Fresh applicants: nothing exists but the login ----
  {
    key: 'fresh-approved',
    title: 'Fresh applicant: approved',
    group: 'FRESH',
    section: 'By intended outcome',
    demonstrates:
      'Walk the whole happy path by hand: business, healthy sandbox bank, instant approval, lease, plan.',
    screens: ['Business', 'Connect bank', 'Application', 'Decision', 'Lease', 'Plan'],
    email: 'fresh-approved@cashflow.local',
    fullName: 'Avery Lindqvist',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'APPROVED',
        summary:
          'Preset: a healthy sandbox bank at $52,000 a month and $5,200 rent. Expect an instant approval.',
        business: freshBusiness({
          legalName: 'Foster Road Coffee LLC',
          dba: 'Foster Road Coffee',
          industry: 'RESTAURANT',
          line1: '6420 SE Foster Rd',
          postalCode: '97206',
          foundedOn: '2020-05-01',
          revenueCents: 5_200_000,
          taxIdLast4: '4410',
          ownerName: 'Avery Lindqvist',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_rev_52000_dev_walk_a1',
        pos: null,
        timeInBusinessMonths: 66,
        requestedMonthlyRentCents: 520_000,
      },
    },
  },
  {
    key: 'fresh-declined',
    title: 'Fresh applicant: declined',
    group: 'FRESH',
    section: 'By intended outcome',
    demonstrates:
      'Watch a decline happen: the sandbox bank returns repeated overdrafts, and the decision lists the reasons.',
    screens: ['Business', 'Connect bank', 'Application', 'Decision (reasons)'],
    email: 'fresh-declined@cashflow.local',
    fullName: 'Jordan Whitlock',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'DECLINED',
        summary:
          'Preset: a sandbox bank with repeated overdrafts at $30,000 a month and $4,000 rent. Expect a decline for overdrafts.',
        business: freshBusiness({
          legalName: 'Kenton Tap House LLC',
          dba: 'Kenton Tap House',
          industry: 'RESTAURANT',
          line1: '8218 N Denver Ave',
          postalCode: '97217',
          foundedOn: '2021-02-01',
          revenueCents: 3_000_000,
          taxIdLast4: '7726',
          ownerName: 'Jordan Whitlock',
        }),
        bankScenario: 'overdrafts',
        bankPublicToken: 'mock_overdrafts_rev_30000_dev_walk_b4',
        pos: null,
        timeInBusinessMonths: 57,
        requestedMonthlyRentCents: 400_000,
      },
    },
  },
  {
    key: 'fresh-referred',
    title: 'Fresh applicant: referred',
    group: 'FRESH',
    section: 'By intended outcome',
    demonstrates:
      'Healthy cash flow, but the tax id ends 0000, which the sandbox identity provider cannot match. Referred to a person: decide it in the ops console.',
    screens: ['Business', 'Connect bank', 'Application', 'Decision (In review)', 'Ops console'],
    email: 'fresh-referred@cashflow.local',
    fullName: 'Casey Okonkwo',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'IN_REVIEW',
        summary:
          'Preset: a healthy sandbox bank, and a tax id ending 0000 that identity verification cannot match. Expect a referral to manual review.',
        business: freshBusiness({
          legalName: 'Montavilla Framing LLC',
          dba: 'Montavilla Framing',
          industry: 'RETAIL',
          line1: '7850 SE Stark St',
          postalCode: '97215',
          foundedOn: '2019-08-01',
          revenueCents: 4_800_000,
          taxIdLast4: '0000',
          ownerName: 'Casey Okonkwo',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_rev_48000_dev_walk_c',
        pos: null,
        timeInBusinessMonths: 75,
        requestedMonthlyRentCents: 480_000,
      },
    },
  },
  {
    key: 'fresh-counter-offer',
    title: 'Fresh applicant: counter offer',
    group: 'FRESH',
    section: 'By intended outcome',
    demonstrates:
      'Asks for more rent than its cash flow carries: approved at a lower limit. A lease at or under the limit can start a plan; the $6,000 lease cannot.',
    screens: ['Business', 'Connect bank', 'Application', 'Decision (lower limit)', 'Lease'],
    email: 'fresh-counter-offer@cashflow.local',
    fullName: 'Riley Abernathy',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'COUNTER_OFFER',
        summary:
          'Preset: a healthy sandbox bank at $30,000 a month asking for $6,000 rent. Expect an approval for less than the request.',
        business: freshBusiness({
          legalName: 'St Johns Ceramics LLC',
          dba: 'St Johns Ceramics',
          industry: 'RETAIL',
          line1: '8704 N Lombard St',
          postalCode: '97203',
          foundedOn: '2020-03-01',
          revenueCents: 3_000_000,
          taxIdLast4: '9052',
          ownerName: 'Riley Abernathy',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_rev_30000_dev_walk_d3',
        timeInBusinessMonths: 68,
        requestedMonthlyRentCents: 600_000,
        pos: null,
      },
    },
  },
  {
    key: 'fresh-payout-elsewhere',
    title: 'Fresh applicant: payout account not connected',
    group: 'FRESH',
    section: 'Data connections',
    demonstrates:
      'Connects Square through the sandbox consent page, but Square pays out to an account that is not connected. The decision asks for that account instead of deciding.',
    screens: [
      'Business',
      'Connect bank',
      'Connect Square',
      'Application',
      'Decision (connect your payout account)',
    ],
    email: 'fresh-payout-elsewhere@cashflow.local',
    fullName: 'Wei Brennan',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'NEEDS_INFO',
        summary:
          'Preset: a healthy sandbox bank, and Square paying out to a different account. Expect a request to connect the payout account.',
        business: freshBusiness({
          legalName: 'Hawthorne Bike Works LLC',
          dba: 'Hawthorne Bike Works',
          industry: 'RETAIL',
          line1: '3570 SE Hawthorne Blvd',
          postalCode: '97214',
          foundedOn: '2019-10-01',
          revenueCents: 4_600_000,
          taxIdLast4: '2218',
          ownerName: 'Wei Brennan',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_rev_46000_dev_walk_f2',
        timeInBusinessMonths: 72,
        requestedMonthlyRentCents: 420_000,
        pos: { platform: 'SQUARE', scenario: 'healthy_sales_46000_payout_elsewhere' },
      },
    },
  },
  {
    key: 'fresh-ownership',
    title: 'Fresh applicant: account held by another business',
    group: 'FRESH',
    section: 'Data connections',
    demonstrates:
      'Connects a sandbox bank account whose holder is a different business. Referred to a person; the owner only sees that it is in review.',
    screens: ['Business', 'Connect bank', 'Application', 'Decision (In review)', 'Ops console'],
    email: 'fresh-ownership@cashflow.local',
    fullName: 'Omar Iyer',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'IN_REVIEW',
        summary:
          'Preset: a healthy sandbox bank held by another business (the borrowed keyword). Expect a referral to manual review.',
        business: freshBusiness({
          legalName: 'Division Street Florals LLC',
          dba: 'Division Street Florals',
          industry: 'RETAIL',
          line1: '2626 SE Division St',
          postalCode: '97202',
          foundedOn: '2019-06-01',
          revenueCents: 4_700_000,
          taxIdLast4: '5163',
          ownerName: 'Omar Iyer',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_borrowed_rev_47000_dev_walk_e1',
        timeInBusinessMonths: 76,
        requestedMonthlyRentCents: 430_000,
        pos: null,
      },
    },
  },
  {
    key: 'fresh-toast',
    title: 'Fresh applicant: Toast through a read-only seat',
    group: 'FRESH',
    section: 'Data connections',
    demonstrates:
      "Invites CashFlow's read-only reports user to Toast, checks the seat, and applies with both sources. Expect an approval with Toast sales matched to the bank.",
    screens: [
      'Business',
      'Connect bank',
      'Connect Toast (seat instructions)',
      'Application',
      'Decision',
    ],
    email: 'fresh-toast@cashflow.local',
    fullName: 'Grace Sato',
    landing: 'BUSINESS_NEW',
    build: {
      kind: 'fresh',
      walkthrough: {
        outcome: 'APPROVED',
        summary:
          'Preset: a healthy sandbox bank and a Toast seat. Expect an instant approval with two verified sources.',
        business: freshBusiness({
          legalName: 'Killingsworth Kitchen LLC',
          dba: 'Killingsworth Kitchen',
          industry: 'RESTAURANT',
          line1: '1101 N Killingsworth St',
          postalCode: '97217',
          foundedOn: '2020-04-01',
          revenueCents: 5_000_000,
          taxIdLast4: '8817',
          ownerName: 'Grace Sato',
        }),
        bankScenario: 'healthy',
        bankPublicToken: 'mock_healthy_rev_50000_dev_walk_g4',
        timeInBusinessMonths: 64,
        requestedMonthlyRentCents: 480_000,
        pos: { platform: 'TOAST', scenario: 'healthy_sales_50000' },
      },
    },
  },
];

export function personaByKey(key: string): PersonaDefinition | undefined {
  return PERSONAS.find((p) => p.key === key);
}
