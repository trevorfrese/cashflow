import { addDays, daysBetween } from '@cashflow/shared';

import type { AlertCandidate, Rule } from '../types.ts';

/**
 * Compliance rules. The deadlines and periods here are working assumptions about what the
 * rules require, kept in `MONITORING_POLICY` and `CONTROLS_POLICY`, to be confirmed by
 * counsel. The rules only measure against them.
 */

/** A complete application that has no answer yet. */
const UNDECIDED = new Set(['SUBMITTED', 'IN_REVIEW']);

export const decisionDeadline: Rule = {
  type: 'compliance.decision_deadline',
  category: 'COMPLIANCE',
  description:
    'A complete application has had no decision for 20 days (warning) or 30 days (critical): the working assumption for the Regulation B deadline to notify an applicant of action taken.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const out: AlertCandidate[] = [];
    for (const a of inputs.applications) {
      if (!UNDECIDED.has(a.status) || a.submittedOn === null) continue;
      const days = daysBetween(a.submittedOn, inputs.asOf);
      if (days < policy.compliance.decisionWarnDays) continue;
      const past = days >= policy.compliance.decisionCriticalDays;
      out.push({
        type: 'compliance.decision_deadline',
        category: 'COMPLIANCE',
        severity: past ? 'CRITICAL' : 'WARNING',
        subjectType: 'application',
        subjectId: a.id,
        title: past
          ? `Application undecided for ${days} days, past the ${policy.compliance.decisionCriticalDays} day deadline: ${a.businessName}`
          : `Application undecided for ${days} days, deadline in ${policy.compliance.decisionCriticalDays - days}: ${a.businessName}`,
        detail: {
          businessId: a.businessId,
          status: a.status,
          submittedOn: a.submittedOn,
          daysWaiting: days,
          deadline: addDays(a.submittedOn, policy.compliance.decisionCriticalDays),
        },
        dedupeKey: `decision_deadline:${a.id}`,
      });
    }
    return out;
  },
};

export const adverseActionNoticeMissing: Rule = {
  type: 'compliance.adverse_action_notice_missing',
  category: 'COMPLIANCE',
  description:
    'A decline or a counter offer has no stored adverse action notice. Inactive until the notice exists: the rule is implemented and tested, and `adverseActionNoticeRuleActive` turns it on.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    if (!policy.compliance.adverseActionNoticeRuleActive) return [];
    return inputs.adverseActions
      .filter(
        (d) =>
          d.noticeSentOn === null &&
          daysBetween(d.decidedOn, inputs.asOf) >= policy.compliance.adverseActionNoticeDays,
      )
      .map((d): AlertCandidate => ({
        type: 'compliance.adverse_action_notice_missing',
        category: 'COMPLIANCE',
        severity: 'HIGH',
        subjectType: 'application',
        subjectId: d.applicationId,
        title: `No adverse action notice stored for a ${d.outcome === 'DECLINED' ? 'decline' : 'counter offer'}: ${d.businessName}`,
        detail: { decisionId: d.decisionId, outcome: d.outcome, decidedOn: d.decidedOn },
        dedupeKey: `adverse_action:${d.decisionId}`,
      }));
  },
};

export const screeningStale: Rule = {
  type: 'compliance.screening_stale',
  category: 'COMPLIANCE',
  description:
    'A business, owner, or landlord tied to a running plan was last screened longer ago than the rescreen interval plus its grace. The rescreen job should have picked it up.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const limit = policy.compliance.rescreenIntervalDays + policy.compliance.screeningGraceDays;
    const stale = inputs.screenings.filter(
      (s) =>
        s.activeParty && s.leaseChangeId === null && daysBetween(s.screenedOn, inputs.asOf) > limit,
    );
    const byBusiness = new Map<string, typeof stale>();
    for (const s of stale)
      byBusiness.set(s.businessId, [...(byBusiness.get(s.businessId) ?? []), s]);
    return [...byBusiness.entries()].map(([businessId, rows]): AlertCandidate => ({
      type: 'compliance.screening_stale',
      category: 'COMPLIANCE',
      severity: 'WARNING',
      subjectType: 'business',
      subjectId: businessId,
      title: `${rows.length} screening result${rows.length === 1 ? '' : 's'} older than ${limit} days: ${rows[0]!.businessName}`,
      detail: {
        businessId,
        limitDays: limit,
        parties: rows.map((r) => ({
          screeningId: r.id,
          partyType: r.partyType,
          partyRef: r.partyRef,
          screenedOn: r.screenedOn,
        })),
      },
      dedupeKey: `screening_stale:${businessId}`,
    }));
  },
};

export const retentionViolation: Rule = {
  type: 'compliance.retention_violation',
  category: 'COMPLIANCE',
  description:
    'An application that was decided inside the retention period no longer exists. Nothing in the product deletes one; the audit log, which cannot be edited, is how the gap is seen. The rule is about never deleting inside the period, not about deleting after it.',
  // A deleted record does not come back by itself.
  autoResolves: false,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.retention
      .filter((r) => !r.exists)
      .map((r): AlertCandidate => ({
        type: 'compliance.retention_violation',
        category: 'COMPLIANCE',
        severity: 'CRITICAL',
        subjectType: 'application',
        subjectId: r.applicationId,
        title: `Application decided on ${r.decidedOn} was deleted inside the retention period`,
        detail: { applicationId: r.applicationId, decidedOn: r.decidedOn },
        dedupeKey: `retention:${r.applicationId}`,
      })),
};

export const identityUnverified: Rule = {
  type: 'compliance.identity_unverified',
  category: 'COMPLIANCE',
  description:
    'A business with a running plan is not verified with the identity provider: it predates verification, its details changed, or a later check failed.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.identities
      .filter((b) => b.hasOpenPlan && b.verificationStatus !== 'VERIFIED')
      .map((b): AlertCandidate => ({
        type: 'compliance.identity_unverified',
        category: 'COMPLIANCE',
        severity: b.verificationStatus === 'FAILED' ? 'HIGH' : 'WARNING',
        subjectType: 'business',
        subjectId: b.businessId,
        title: `Business with a running plan is ${b.verificationStatus.toLowerCase()}: ${b.businessName}`,
        detail: { businessId: b.businessId, status: b.verificationStatus, reasons: b.reasons },
        dedupeKey: `identity_unverified:${b.businessId}`,
      })),
};

export const COMPLIANCE_RULES: Rule[] = [
  decisionDeadline,
  adverseActionNoticeMissing,
  screeningStale,
  retentionViolation,
  identityUnverified,
];
