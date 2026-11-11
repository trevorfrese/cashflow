import { z } from 'zod';

import { AuthResponse } from './auth';
import { CreateBusinessRequest } from './business';
import { CommercePlatform } from './commerce';
import { Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Shapes for the dev tools: personas, the simulated clock, resets, and the "what just
 * happened" feed. The routes that speak them live under `/v1/dev` and are registered only
 * when the API runs with `ENABLE_DEV_TOOLS=true`, which it refuses to do in production.
 * Nothing here is part of the product.
 */

/** Existing customers are built by the seed. Fresh applicants start with nothing but a login. */
export const DevPersonaGroup = z.enum(['CUSTOMER', 'FRESH']);
export type DevPersonaGroup = z.infer<typeof DevPersonaGroup>;

export const DEV_PERSONA_GROUP_LABELS: Record<DevPersonaGroup, string> = {
  CUSTOMER: 'Existing customers',
  FRESH: 'Fresh applicants',
};

/** The screen the app opens on after signing in as a persona. */
export const DevLandingScreen = z.enum([
  'HOME',
  'APPLICATION',
  'HISTORY',
  'BUSINESS_NEW',
  'CONNECTIONS',
]);
export type DevLandingScreen = z.infer<typeof DevLandingScreen>;

/** What a fresh applicant's preset inputs are meant to end in. */
export const DevWalkthroughOutcome = z.enum([
  'APPROVED',
  'DECLINED',
  'IN_REVIEW',
  'COUNTER_OFFER',
  'NEEDS_INFO',
]);
export type DevWalkthroughOutcome = z.infer<typeof DevWalkthroughOutcome>;

/**
 * The inputs a fresh applicant persona is preconfigured with. The app prefills its
 * onboarding forms from this and says so on screen; nothing is created until the developer
 * submits each step.
 */
export const DevWalkthrough = z.object({
  outcome: DevWalkthroughOutcome,
  /** One line shown above the prefilled forms: what was preselected and why. */
  summary: z.string(),
  /** The business profile, exactly as `POST /v1/businesses` takes it. */
  business: CreateBusinessRequest,
  /** Sandbox bank scenario keyword, for example "healthy" or "overdrafts". */
  bankScenario: z.string(),
  /** The whole sandbox bank public token. Stable, so the decision is the same every time. */
  bankPublicToken: z.string(),
  timeInBusinessMonths: z.number().int().min(0).max(1200),
  requestedMonthlyRentCents: Cents,
  /**
   * A point of sale to connect before applying: the platform, and the keywords the sandbox
   * consent page (or seat) is given. Null when the preset connects only a bank.
   */
  pos: z.object({ platform: CommercePlatform, scenario: z.string() }).nullable().default(null),
});
export type DevWalkthrough = z.infer<typeof DevWalkthrough>;

export const DevPersonaTone = z.enum(['neutral', 'paid', 'due', 'late', 'info', 'gold']);
export type DevPersonaTone = z.infer<typeof DevPersonaTone>;

/** Where a persona's account stands right now, read from the database. */
export const DevPersonaState = z.object({
  /** False until the account has been created (before the first seed or reset). */
  exists: z.boolean(),
  /** Short label for a status tag, for example "Delinquent, payout held". */
  label: z.string(),
  tone: DevPersonaTone,
  businessName: z.string().nullable(),
});
export type DevPersonaState = z.infer<typeof DevPersonaState>;

export const DevNextEvent = z.object({
  date: IsoDateSchema,
  /** For example "Landlord payout due" or "Charge-off". */
  label: z.string(),
});
export type DevNextEvent = z.infer<typeof DevNextEvent>;

export const DevPersona = z.object({
  /** Stable identifier, for example "delinquent". */
  key: z.string(),
  title: z.string(),
  group: DevPersonaGroup,
  /** Sub heading inside the group, for example "Plans" or "Decisions". */
  section: z.string(),
  /** One line: what this persona is for. */
  demonstrates: z.string(),
  /** Screens worth visiting, as the app names them. */
  screens: z.array(z.string()),
  /** The account's sign in email. Every persona uses the demo password. */
  email: z.string(),
  /**
   * True when "reset this persona" can rebuild only this account. False for personas whose
   * state is months of replayed ledger history: those are rebuilt by a full reset.
   */
  resettable: z.boolean(),
  walkthrough: DevWalkthrough.nullable(),
  state: DevPersonaState,
  /** The next date something happens to this persona, or null. */
  nextEvent: DevNextEvent.nullable(),
});
export type DevPersona = z.infer<typeof DevPersona>;

export const DevClock = z.object({
  /** The date the API treats as today. */
  today: IsoDateSchema,
  /** The real UTC date. */
  wallToday: IsoDateSchema,
  /** Days the simulated date is ahead of the real one. 0 when they agree. */
  aheadDays: z.number().int().min(0),
});
export type DevClock = z.infer<typeof DevClock>;

export const DevPersonaList = z.object({
  clock: DevClock,
  /** The password every persona account is created with. Sandbox only. */
  password: z.string(),
  personas: z.array(DevPersona),
});
export type DevPersonaList = z.infer<typeof DevPersonaList>;

/** A normal session, the same shape as login, plus who it is and where to land. */
export const DevSession = AuthResponse.extend({
  persona: DevPersona,
  landing: z.object({
    screen: DevLandingScreen,
    /** Set when `screen` is APPLICATION. */
    applicationId: Id.nullable(),
  }),
});
export type DevSession = z.infer<typeof DevSession>;

/** Most days one call may cross. Each day runs every job once. */
export const DEV_CLOCK_MAX_DAYS = 120;

/** Exactly one of the three. */
export const DevAdvanceRequest = z
  .object({
    days: z.number().int().min(1).max(DEV_CLOCK_MAX_DAYS).optional(),
    toDate: IsoDateSchema.optional(),
    /** A persona key: advance to the next date something happens to it. */
    toNextEventFor: z.string().optional(),
  })
  .refine(
    (v) => [v.days, v.toDate, v.toNextEventFor].filter((x) => x !== undefined).length === 1,
    'Send exactly one of days, toDate, or toNextEventFor',
  );
export type DevAdvanceRequest = z.infer<typeof DevAdvanceRequest>;

const Count = z.number().int().min(0);

export const DevAdvanceResult = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  days: Count,
  clock: DevClock,
  /** Set when the advance was to a persona's next event. */
  event: DevNextEvent.nullable(),
  summary: z.object({
    periodsCreated: Count,
    payoutsPaid: Count,
    payoutsHeld: Count,
    payoutsCancelled: Count,
    payoutsFailed: Count,
    installmentsCollected: Count,
    installmentsFailed: Count,
    installmentsLate: Count,
    standingChanges: Count,
    plansChargedOff: Count,
    alertsOpened: Count,
    alertsResolved: Count,
  }),
  /** The same in sentences, most important first, for showing as a list. */
  changes: z.array(z.string()),
  /** Jobs that failed on a day that was crossed. Empty when everything ran. */
  jobFailures: z.array(z.object({ asOf: IsoDateSchema, job: z.string(), error: z.string() })),
});
export type DevAdvanceResult = z.infer<typeof DevAdvanceResult>;

export const DevResetResult = z.object({
  clock: DevClock,
  /** Seconds the rebuild took. */
  seconds: z.number().min(0),
  personas: z.array(DevPersona),
});
export type DevResetResult = z.infer<typeof DevResetResult>;

export const DevOverview = z.object({
  clock: DevClock,
  environment: z.object({
    nodeEnv: z.string(),
    providers: z.record(z.string(), z.string()),
    jobsEnabled: z.boolean(),
    adminEnabled: z.boolean(),
  }),
  counts: z.object({
    users: Count,
    businesses: Count,
    applicationsInReview: Count,
    plans: Count,
    /** Plans by delinquency bucket. */
    plansByStanding: z.record(z.string(), Count),
    heldPayouts: Count,
    /** Alerts that are not resolved, by severity. */
    openAlerts: z.record(z.string(), Count),
  }),
  ledger: z.object({
    balanced: z.boolean(),
    totalDebitsCents: z.number().int(),
    totalCreditsCents: z.number().int(),
    capitalPoolCents: z.number().int(),
    receivablesCents: z.number().int(),
  }),
  circuitBreakerTripped: z.boolean(),
});
export type DevOverview = z.infer<typeof DevOverview>;

export const DevFeed = z.object({
  clock: DevClock,
  /** One row per job and as-of date, newest first. */
  jobRuns: z.array(
    z.object({
      id: Id,
      name: z.string(),
      asOf: IsoDateSchema,
      startedAt: IsoDateTimeSchema,
      ok: z.boolean().nullable(),
      error: z.string().nullable(),
      summary: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  auditEvents: z.array(
    z.object({
      id: Id,
      at: IsoDateTimeSchema,
      eventType: z.string(),
      actorType: z.string(),
      subjectType: z.string(),
      subjectId: z.string(),
    }),
  ),
  alerts: z.array(
    z.object({
      id: Id,
      type: z.string(),
      severity: z.string(),
      status: z.string(),
      title: z.string(),
      createdAt: IsoDateTimeSchema,
    }),
  ),
});
export type DevFeed = z.infer<typeof DevFeed>;
