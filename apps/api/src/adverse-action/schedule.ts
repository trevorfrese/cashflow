import { addDays, type AdverseActionNoticeKind, type IsoDate } from '@cashflow/shared';

import { NOTICE_POLICY } from './policy.ts';

/**
 * Which notices an application is owed, and by when. Pure: the notices job creates what is
 * due and missing, and the monitoring rules compare what is due with what was stored, both
 * through this one function.
 */

export interface StoredNoticeFact {
  decisionId: string;
  kind: AdverseActionNoticeKind;
  deliveredOn: IsoDate;
  deadlineOn: IsoDate;
  respondBy: IsoDate | null;
}

export interface ApplicationNoticeFacts {
  applicationId: string;
  businessId: string;
  businessName: string;
  status: string;
  submittedOn: IsoDate | null;
  requestedMonthlyRentCents: number;
  /** The current origination decision. */
  decision: {
    id: string;
    kind: string;
    outcome: string;
    decidedOn: IsoDate;
    approvedMonthlyLimitCents: number | null;
  } | null;
  /** A financed plan was opened on the application: a counter offer was taken up. */
  hasFinancedPlan: boolean;
  notices: StoredNoticeFact[];
}

export interface DueNotice {
  applicationId: string;
  businessId: string;
  businessName: string;
  decisionId: string;
  kind: AdverseActionNoticeKind;
  /** The day the notice became due to be sent. */
  actionOn: IsoDate;
  /** The last day it may be delivered. */
  deadlineOn: IsoDate;
  /** For a notice of incompleteness, the date to respond by. */
  respondBy: IsoDate | null;
  /** The notice already stored for it, if there is one. */
  stored: StoredNoticeFact | null;
}

/** Decision kinds that answer an application. Periodic and eligibility reviews do not. */
const ORIGINATION = new Set(['ENGINE', 'REVIEW']);

export function isCounterOffer(f: ApplicationNoticeFacts): boolean {
  const d = f.decision;
  return (
    d !== null &&
    d.outcome === 'APPROVED' &&
    d.approvedMonthlyLimitCents !== null &&
    d.approvedMonthlyLimitCents < f.requestedMonthlyRentCents
  );
}

/** The day a counter offer stops being open, if not taken up. */
export function counterOfferExpiresOn(decidedOn: IsoDate): IsoDate {
  return addDays(decidedOn, NOTICE_POLICY.counterOfferValidDays);
}

/**
 * Every notice the application is owed as of `asOf`, stored or not. A notice that is not
 * yet due (a counter offer still open, a request for information still young) is absent.
 */
export function dueNotices(f: ApplicationNoticeFacts, asOf: IsoDate): DueNotice[] {
  const d = f.decision;
  if (!d || !ORIGINATION.has(d.kind)) return [];
  const stored = (kind: AdverseActionNoticeKind) =>
    f.notices.find((n) => n.decisionId === d.id && n.kind === kind) ?? null;
  const due = (
    kind: AdverseActionNoticeKind,
    actionOn: IsoDate,
    deadlineOn: IsoDate,
    respondBy: IsoDate | null = null,
  ): DueNotice => ({
    applicationId: f.applicationId,
    businessId: f.businessId,
    businessName: f.businessName,
    decisionId: d.id,
    kind,
    actionOn,
    deadlineOn,
    respondBy,
    stored: stored(kind),
  });
  const received = f.submittedOn ?? d.decidedOn;

  if (d.outcome === 'DECLINED' && f.status === 'DECLINED') {
    // 30 days from the completed application, whoever declined it.
    return [due('DECLINE', d.decidedOn, addDays(received, NOTICE_POLICY.noticeDays))];
  }

  if (isCounterOffer(f) && f.status === 'APPROVED') {
    const declined = stored('COUNTER_OFFER_NOT_ACCEPTED');
    if (f.hasFinancedPlan && !declined) return [];
    const expires = counterOfferExpiresOn(d.decidedOn);
    const deadline = addDays(d.decidedOn, NOTICE_POLICY.counterOfferNoticeDays);
    if (declined) return [due('COUNTER_OFFER_NOT_ACCEPTED', declined.deliveredOn, deadline)];
    if (asOf < expires) return [];
    return [due('COUNTER_OFFER_NOT_ACCEPTED', expires, deadline)];
  }

  if (d.outcome === 'NEEDS_INFO' && f.status === 'NEEDS_INFO') {
    const askOn = addDays(d.decidedOn, NOTICE_POLICY.incompleteNoticeAfterDays);
    if (asOf < askOn) return [];
    const asked = stored('INCOMPLETE');
    const askedOn = asked?.deliveredOn ?? askOn;
    const respondBy = asked?.respondBy ?? addDays(askedOn, NOTICE_POLICY.incompleteResponseDays);
    const out = [due('INCOMPLETE', askOn, addDays(received, NOTICE_POLICY.noticeDays), respondBy)];
    // Closed the day after the date to respond by passes, and only once the applicant was
    // actually told what was missing and given that date.
    const closeOn = addDays(respondBy, 1);
    if (asked && asOf >= closeOn) {
      out.push(
        due(
          'INCOMPLETE_DECLINED',
          closeOn,
          addDays(closeOn, NOTICE_POLICY.incompleteDeclinedNoticeDays),
        ),
      );
    }
    return out;
  }
  return [];
}
