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
import {
  apply,
  approvedLimitCents,
  createBusiness,
  createLease,
  linkBank,
  monthsAgo,
  monthsBefore,
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
      },
    },
  },
];

export function personaByKey(key: string): PersonaDefinition | undefined {
  return PERSONAS.find((p) => p.key === key);
}
