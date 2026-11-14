import type { AlertCategory, AlertSeverity } from '@cashflow/shared';

import type { AlertCandidate, AuditEventFact, Rule } from '../types.ts';

/**
 * Alerts from audit events.
 *
 * Servicing and auth already detect these and write an audit event in the same transaction
 * as the change. Detecting them a second time here would be a second definition that could
 * drift, so these rules only turn the events that need a person into alerts: one per event,
 * keyed by the event's id, opened once and never reopened after it is resolved.
 *
 * Events that are routine (`PAYOUT_HELD`, `DELINQUENCY_CHANGED`, `PAYMENT_RETURNED`,
 * `COLLECTION_SKIPPED`) are left in the log: the state rules cover what they add up to.
 */
interface EventAlert {
  eventType: string;
  type: string;
  category: AlertCategory;
  severity: AlertSeverity;
  description: string;
  title: (e: AuditEventFact) => string;
}

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

const EVENT_ALERTS: EventAlert[] = [
  {
    eventType: 'UNAUTHORIZED_RETURN',
    type: 'fraud.unauthorized_return',
    category: 'FRAUD',
    severity: 'HIGH',
    description:
      'A bank debit came back as not authorized (R05, R07, R10, R29). The plan is already frozen and the bank link disabled. Every one is investigated: the network counts them against a 0.5% threshold.',
    title: (e) => `Unauthorized return ${text(e.payload.returnCode)} on a rent plan`,
  },
  {
    eventType: 'PAYOUT_RETURNED',
    type: 'payments.payout_returned',
    category: 'PAYMENTS',
    severity: 'HIGH',
    description:
      'A landlord payout came back from the landlord bank. The plan is frozen. The landlord details need correcting, any principal already collected is owed back, and the payout can then be sent again.',
    title: (e) =>
      `Landlord payout for ${text(e.payload.periodMonth)} returned ${text(e.payload.returnCode)}`,
  },
  {
    eventType: 'PLAN_CHARGED_OFF',
    type: 'portfolio.plan_charged_off',
    category: 'PORTFOLIO',
    severity: 'HIGH',
    description:
      'A plan reached the charge-off age and its unpaid balance was written off. Recovery work starts here.',
    title: (e) =>
      `Plan charged off: ${(Number(e.payload.principalCents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} of principal`,
  },
  {
    eventType: 'BANK_LINK_DISABLED',
    type: 'payments.bank_link_disabled',
    category: 'PAYMENTS',
    severity: 'WARNING',
    description:
      'A hard or unauthorized return disabled a bank link. No automatic debit is made until the business links an account again, so someone should reach out.',
    title: (e) => `Bank link disabled by return ${text(e.payload.returnCode)}`,
  },
  {
    eventType: 'PAYOUT_CANCELLED',
    type: 'payments.payout_cancelled',
    category: 'PAYMENTS',
    severity: 'WARNING',
    description:
      'A landlord payout was not paid inside its release window and was cancelled. The landlord did not get that month from us, and the owner should hear it from a person.',
    title: (e) =>
      `Landlord payout for ${monthLabel(e.payload.periodMonth)} cancelled: ${cancelReason(e.payload.reason)}`,
  },
  {
    eventType: 'LOGIN_LOCKED',
    type: 'fraud.login_lockout',
    category: 'FRAUD',
    severity: 'INFO',
    description:
      'An account was locked after repeated failed sign ins. Usually a forgotten password. Several at once is credential stuffing.',
    title: () => 'Account locked after repeated failed sign ins',
  },
  {
    eventType: 'PASS_THROUGH_RETURNED_AFTER_PAYOUT',
    type: 'payments.pass_through_returned_after_payout',
    category: 'PAYMENTS',
    severity: 'HIGH',
    description:
      'A pass-through rent collection came back after the landlord had been paid with it, usually an unauthorized return weeks later. CashFlow covered the rent from its own money, the business owes it on its receivable account, which is collected and charged off like a financed installment, and the plan advances nothing while it is owed. Someone has to contact the owner.',
    title: (e) =>
      `Pass-through rent for ${text(e.payload.periodMonth)} returned ${text(e.payload.returnCode)} after the landlord was paid`,
  },
  {
    eventType: 'DUPLICATE_PAYOUT_PREVENTED',
    type: 'payments.duplicate_payout_prevented',
    category: 'PAYMENTS',
    severity: 'HIGH',
    description:
      'A landlord payment was refused because the landlord was already paid for that lease and month, by the same plan or another one. Nothing was sent twice, but something tried to: find out what.',
    title: (e) => `Second landlord payment for ${text(e.payload.periodMonth)} refused`,
  },
];

function eventRule(spec: EventAlert): Rule {
  return {
    type: spec.type,
    category: spec.category,
    description: spec.description,
    autoResolves: false,
    once: true,
    tripsCircuitBreaker: false,
    evaluate: (inputs) =>
      inputs.auditEvents
        .filter((e) => e.eventType === spec.eventType)
        // A plan closed before the payout fell due cancels it as a matter of course.
        // A payout cancelled because the month was already paid has its own alert, from
        // DUPLICATE_PAYOUT_PREVENTED.
        .filter(
          (e) =>
            !(
              spec.eventType === 'PAYOUT_CANCELLED' &&
              (e.payload.reason === 'PLAN_CLOSED' || e.payload.reason === 'PERIOD_ALREADY_PAID')
            ),
        )
        .map((e): AlertCandidate => ({
          type: spec.type,
          category: spec.category,
          severity: spec.severity,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          title: spec.title(e),
          detail: { auditEventId: e.id, on: e.on, ...e.payload },
          dedupeKey: `audit:${e.id}`,
        })),
  };
}

/** The audit event types the data layer has to load for these rules. */
export const ALERTED_EVENT_TYPES = EVENT_ALERTS.map((e) => e.eventType);

export const EVENT_RULES: Rule[] = EVENT_ALERTS.map(eventRule);

/** Why a payout was cancelled, in words for an alert title. Unknown codes read as words. */
const CANCEL_REASONS: Record<string, string> = {
  PAST_DUE: 'an earlier installment was past due',
  ADVANCE_FROZEN: 'the plan was frozen',
  PLAN_PAUSED: 'the plan was paused',
  PLAN_CLOSED: 'the plan was closed',
  NOT_PAID_IN_TIME: 'not paid inside the release window',
  LEASE_CHANGE_PENDING: 'a landlord change was waiting',
  RENT_INCREASE_PENDING: 'a rent increase was waiting for approval',
  PERIOD_ALREADY_PAID: 'the month was already paid',
  GRADUATED: 'the plan graduated',
};

function cancelReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason === '') return 'reason not recorded';
  return CANCEL_REASONS[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08" as "Aug 2026". Anything else as it came. */
function monthLabel(v: unknown): string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})$/.exec(v) : null;
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : text(v);
}
