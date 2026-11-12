import {
  addDays,
  catalogEntry,
  COMMERCE_PLATFORM_LABELS,
  FACTOR_CODES,
  formatCents,
  type DecisionExplanation,
  type DecisionReason,
  type ExplanationCheck,
  type ExplanationFactor,
  type IsoDate,
} from '@cashflow/shared';

import { isCounterOffer } from '../adverse-action/schedule.ts';
import { longDate, NOTICE_TITLES } from '../adverse-action/render.ts';
import type {
  AdverseActionNotice,
  BankLink,
  CommerceLink,
  UnderwritingApplication,
  UnderwritingDecision,
} from '../generated/prisma/client.ts';
import type { DecisionSnapshot } from '../underwriting/engine.ts';
import { CONTROLS_POLICY } from '../controls/policy.ts';
import { todayIso } from '../dates.ts';
import { decisionPrincipalReasons } from './adverse-action.ts';

/**
 * Why an applicant got the decision they got, in their words: the principal reasons, each
 * scorecard factor as helping, neutral or hurting, the rules that ran, the data read, and the
 * terms. Built from the stored decision, never by running the engine again.
 *
 * The score and grade appear only on an approval or a counter offer. A decline can come from
 * a rule while the score is high, and a green "A" beside "not approved" misleads; on a
 * decline or a referral the applicant sees the reasons and the factor statuses instead. No
 * point values, weights, cutoffs or internal flags are ever included.
 */

type Application = UnderwritingApplication & {
  bankLink: BankLink | null;
  commerceLink: CommerceLink | null;
};

const day = (d: Date): IsoDate => d.toISOString().slice(0, 10);
const usd = (cents: number) => formatCents(cents, { showCents: false });

/** The rules the engine applies before pricing, and the reason codes each one declines with. */
const CHECKS: ReadonlyArray<{ code: string; label: string; failsWith: readonly string[] }> = [
  { code: 'TIME_IN_BUSINESS', label: 'Time in business', failsWith: ['TIME_IN_BUSINESS'] },
  { code: 'REVENUE', label: 'Monthly revenue', failsWith: ['REVENUE_TOO_LOW'] },
  { code: 'OVERDRAFTS', label: 'Overdraft fees', failsWith: ['EXCESSIVE_OVERDRAFTS'] },
  { code: 'DAYS_OVERDRAWN', label: 'Days overdrawn', failsWith: ['NEGATIVE_BALANCE_DAYS'] },
  {
    code: 'RENT_SHARE',
    label: 'Rent compared with revenue',
    failsWith: ['RENT_EXCEEDS_REVENUE_SHARE'],
  },
  {
    code: 'REVENUE_TREND',
    label: 'Revenue holding up',
    failsWith: ['REVENUE_DECLINING', 'DECLINE_WITH_THIN_BUFFER'],
  },
  {
    code: 'FREE_CASH_FLOW',
    label: 'Cash left after expenses',
    failsWith: ['NEGATIVE_FREE_CASH_FLOW'],
  },
  {
    code: 'OVERALL',
    label: 'Overall cash flow strength',
    failsWith: ['SCORE_BELOW_MINIMUM'],
  },
  { code: 'IDENTITY', label: 'Business identity', failsWith: ['IDENTITY_NOT_VERIFIED'] },
  {
    code: 'DEPOSITS',
    label: 'Deposits are revenue',
    failsWith: ['UNVERIFIED_DEPOSITS', 'INTEGRITY_CHECK_FAILED'],
  },
  {
    code: 'ACCOUNTS',
    label: 'Connected accounts are your own',
    failsWith: ['ACCOUNT_OWNERSHIP_NOT_CONFIRMED', 'ACCOUNT_HISTORY_NOT_VERIFIED'],
  },
  { code: 'LANDLORD', label: 'Landlord account', failsWith: ['LANDLORD_ACCOUNT_MATCH'] },
];

/** Reached only when no rule above declined: the amount, price and limits. */
const AMOUNT_CHECK = {
  code: 'AMOUNT',
  label: 'Amount we can front',
  failsWith: [
    'INSUFFICIENT_CAPACITY',
    'RENT_NOT_VERIFIED',
    'EXPOSURE_LIMIT',
    'EXPOSURE_LIMIT_REACHED',
    'RENT_BELOW_MINIMUM',
    'FEE_ABOVE_MAXIMUM',
  ],
} as const;

function checksFor(reasons: readonly DecisionReason[]): ExplanationCheck[] {
  const byCode = new Map(reasons.map((r) => [r.code, r]));
  const failing = (codes: readonly string[]) => codes.map((c) => byCode.get(c)).find(Boolean);
  const out: ExplanationCheck[] = CHECKS.map((c) => {
    const fail = failing(c.failsWith);
    return {
      code: c.code,
      label: c.label,
      passed: !fail,
      detail: fail ? fail.message : 'Met.',
    };
  });
  const ruleFailed = out.some((c) => !c.passed);
  if (!ruleFailed) {
    const fail = failing(AMOUNT_CHECK.failsWith);
    const partial = byCode.get('LIMIT_BELOW_REQUEST');
    out.push({
      code: AMOUNT_CHECK.code,
      label: AMOUNT_CHECK.label,
      passed: !fail,
      detail: fail?.message ?? partial?.message ?? 'The rent requested fits.',
    });
  }
  return out;
}

function factorsFor(reasons: readonly DecisionReason[]): ExplanationFactor[] {
  const byCode = new Map(reasons.map((r) => [r.code, r]));
  return FACTOR_CODES.flatMap((code) => {
    const r = byCode.get(code);
    const entry = catalogEntry(code);
    if (!r || !entry) return [];
    return [
      {
        code,
        label: entry.title,
        status:
          r.impact === 'POSITIVE'
            ? ('HELPING' as const)
            : r.impact === 'NEGATIVE'
              ? ('HURTING' as const)
              : ('NEUTRAL' as const),
        measures: entry.measures ?? '',
        detail: r.message,
      },
    ];
  });
}

export function buildExplanation(
  application: Application,
  decision: UnderwritingDecision | null,
  notices: readonly AdverseActionNotice[],
): DecisionExplanation {
  const base: DecisionExplanation = {
    applicationId: application.id,
    outcome: 'NOT_SUBMITTED',
    decidedAt: null,
    headline: 'Not submitted yet',
    summary: 'Submit the application to get a decision.',
    score: null,
    principalReasons: [],
    requestedInformation: [],
    factors: [],
    checks: [],
    dataSources: [],
    terms: null,
    nextSteps: null,
    canDeclineOffer: false,
    notices: notices.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: NOTICE_TITLES[n.kind],
      deliveredAt: n.deliveredAt.toISOString(),
    })),
  };
  if (!decision) return base;

  const reasons = (decision.reasons as unknown as DecisionReason[]) ?? [];
  const snapshot = (decision.snapshot as unknown as DecisionSnapshot | null) ?? null;
  const requested = application.requestedMonthlyRentCents;
  const counter =
    application.status === 'APPROVED' &&
    isCounterOffer({
      requestedMonthlyRentCents: requested,
      decision: {
        id: decision.id,
        kind: decision.kind,
        outcome: decision.outcome,
        decidedOn: day(decision.decidedAt),
        approvedMonthlyLimitCents: decision.approvedMonthlyLimitCents,
      },
    } as Parameters<typeof isCounterOffer>[0]);
  const outcome: DecisionExplanation['outcome'] =
    application.status === 'IN_REVIEW'
      ? 'IN_REVIEW'
      : application.status === 'DECLINED'
        ? 'DECLINED'
        : application.status === 'NEEDS_INFO'
          ? 'NEEDS_INFO'
          : application.status === 'APPROVED'
            ? counter
              ? 'COUNTER_OFFER'
              : 'APPROVED'
            : 'NOT_SUBMITTED';
  const scored = decision.score !== null;
  const out: DecisionExplanation = {
    ...base,
    outcome,
    decidedAt: decision.decidedAt.toISOString(),
    factors: scored ? factorsFor(reasons) : [],
    checks: scored ? checksFor(reasons) : [],
    dataSources: dataSources(application, snapshot),
  };

  const limit = decision.approvedMonthlyLimitCents ?? 0;
  const approved = outcome === 'APPROVED' || outcome === 'COUNTER_OFFER';
  if (approved && decision.score !== null && decision.grade) {
    out.score = {
      value: decision.score,
      grade: decision.grade as NonNullable<DecisionExplanation['score']>['grade'],
    };
  }
  if (approved && decision.feeBps !== null) {
    // The score, limit and helping factors are each shown on their own already, so this
    // only says what sets the fee rather than repeating them.
    out.terms = {
      requestedMonthlyRentCents: requested,
      approvedMonthlyLimitCents: limit,
      feeBps: decision.feeBps,
      installmentsPerMonth: decision.recommendedInstallmentsPerMonth ?? 2,
      why: 'The fee is set by your cash flow: the stronger it is, the lower the fee.',
    };
  }

  switch (outcome) {
    case 'APPROVED':
      out.headline = "You're approved";
      out.summary = `We can pay rent of up to ${usd(limit)} a month for you. Link your lease to start.`;
      break;
    case 'COUNTER_OFFER': {
      out.headline = 'Approved for less than you asked';
      out.summary = `We can pay up to ${usd(limit)} a month, less than the ${usd(requested)} rent you asked for. We pay a whole month's rent or none of it, so a plan can start on a lease at or below that amount.`;
      out.principalReasons = decisionPrincipalReasons(decision, requested);
      const notified = notices.some(
        (n) => n.decisionId === decision.id && n.kind === 'COUNTER_OFFER_NOT_ACCEPTED',
      );
      out.canDeclineOffer = !notified;
      break;
    }
    case 'DECLINED':
      out.headline = 'Not approved right now';
      out.summary =
        'We could not approve this application. These are the reasons that mattered most, with what would change each one.';
      out.principalReasons = decisionPrincipalReasons(decision, requested);
      break;
    case 'IN_REVIEW': {
      const submitted = application.submittedAt ? day(application.submittedAt) : null;
      const expectedBy = submitted ? addDays(submitted, CONTROLS_POLICY.decisionNoticeDays) : null;
      out.headline = 'In review';
      out.summary =
        'A person on our team is looking at your application before we confirm terms. Nothing is needed from you right now.';
      const overdue = expectedBy !== null && expectedBy < todayIso();
      out.nextSteps = {
        text: !expectedBy
          ? 'We will tell you the outcome, and the reasons if we cannot approve it. If we need anything we will ask in the app.'
          : overdue
            ? `This is taking longer than it should: we meant to answer by ${longDate(expectedBy)}. Someone is on it, and we will tell you the outcome, and the reasons if we cannot approve it, as soon as it is decided.`
            : `We will tell you the outcome, and the reasons if we cannot approve it, by ${longDate(expectedBy)}. If we need anything we will ask in the app.`,
        expectedBy,
      };
      break;
    }
    case 'NEEDS_INFO': {
      out.headline = 'A little more information';
      const asked = reasons.find((r) => r.code === 'INFO_REQUESTED');
      out.summary = asked
        ? asked.message
        : 'We need one more thing before we can decide. Provide it, then run the decision again.';
      out.requestedInformation = decisionPrincipalReasons(decision, requested);
      const incomplete = notices.find(
        (n) => n.decisionId === decision.id && n.kind === 'INCOMPLETE',
      );
      if (incomplete?.respondBy) {
        out.nextSteps = {
          text: `Please provide it by ${longDate(incomplete.respondBy)}. After that date the application is closed as incomplete, and you can apply again.`,
          expectedBy: incomplete.respondBy,
        };
      }
      break;
    }
    default:
      break;
  }
  return out;
}

function dataSources(
  application: Application,
  snapshot: DecisionSnapshot | null,
): DecisionExplanation['dataSources'] {
  const pulled = new Map(
    (snapshot?.veracity?.snapshots ?? []).map((s) => [s.connectionId, s.pulledAt.slice(0, 10)]),
  );
  const out: DecisionExplanation['dataSources'] = [];
  const bank = application.bankLink;
  if (bank) {
    out.push({
      kind: 'BANK',
      name: `${bank.institutionName} account ending ${bank.accountMask}`,
      dataAsOf: pulled.get(bank.id) ?? snapshot?.inputs.asOf ?? null,
    });
  }
  const pos = application.commerceLink;
  if (pos) {
    out.push({
      kind: 'COMMERCE',
      name: COMMERCE_PLATFORM_LABELS[pos.platform],
      dataAsOf: pulled.get(pos.id) ?? null,
    });
  }
  return out;
}
