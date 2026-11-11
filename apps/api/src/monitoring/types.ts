import type { AlertCategory, AlertSeverity, IsoDate } from '@cashflow/shared';

import type { MonitoringPolicy } from './policy.ts';

/** What a rule returns: an alert that should be open right now. */
export interface AlertCandidate {
  type: string;
  category: AlertCategory;
  severity: AlertSeverity;
  subjectType: string;
  subjectId: string;
  title: string;
  detail: Record<string, unknown>;
  /** Stable for the same condition on the same subject, so it opens one alert. */
  dedupeKey: string;
  /** Opening this alert, or raising it to this severity, trips the circuit breaker. */
  tripsBreaker?: boolean;
}

export interface Rule {
  /** Also the alert type. */
  type: string;
  category: AlertCategory;
  description: string;
  /**
   * The monitor resolves the alert when the rule no longer returns it. Only for conditions
   * that are fully described by current state, where "gone" means "fixed".
   */
  autoResolves: boolean;
  /**
   * The alert is about something that happened, not something that is. It opens once per
   * event and is never opened again after it has been resolved.
   */
  once: boolean;
  /** At its highest severity the rule trips the circuit breaker. */
  tripsCircuitBreaker: boolean;
  evaluate(inputs: MonitoringInputs, policy: MonitoringPolicy): AlertCandidate[];
}

// ---------- Inputs. Gathered by `data.ts`; the rules never touch the database. ----------

export interface LeaseChangeFact {
  id: string;
  leaseId: string;
  businessId: string;
  businessName: string;
  status: 'PENDING' | 'APPLIED';
  fields: string[];
  requestedOn: IsoDate;
  effectiveOn: IsoDate;
  appliedOn: IsoDate | null;
  /** Approved early by a reviewer. */
  approvedBy: string | null;
  /** Payouts on the lease that are not paid or cancelled: the next ones to go out. */
  upcomingPayouts: Array<{
    id: string;
    scheduledFor: IsoDate;
    amountCents: number;
    status: string;
  }>;
}

export interface LandlordAccountFact {
  leaseId: string;
  businessId: string;
  businessName: string;
  ownerUserId: string;
  landlordName: string;
  holderName: string;
  routingNumber: string;
  last4: string;
  payoutToken: string;
  hasOpenPlan: boolean;
}

export interface BankAccountFact {
  bankLinkId: string;
  businessId: string;
  businessName: string;
  dba: string | null;
  ownerUserId: string;
  accountToken: string;
  mask: string;
}

export interface ApplicationFact {
  id: string;
  businessId: string;
  businessName: string;
  ownerUserId: string;
  status: string;
  createdOn: IsoDate;
  /** When the application was complete and submitted. Null for a draft. */
  submittedOn: IsoDate | null;
  /** Date of the current decision when it is a decline. */
  declinedOn: IsoDate | null;
}

export interface AuditEventFact {
  id: string;
  on: IsoDate;
  eventType: string;
  subjectType: string;
  subjectId: string;
  severity: string | null;
  payload: Record<string, unknown>;
}

export interface DebitFact {
  id: string;
  bankLinkId: string;
  rentPlanId: string;
  businessId: string;
  on: IsoDate;
  status: 'SUCCEEDED' | 'FAILED' | 'RETURNED';
  returnCode: string | null;
}

export interface ExhaustedFact {
  rentPlanId: string;
  businessId: string;
  businessName: string;
  installments: number;
  owedCents: number;
  oldestDueDate: IsoDate;
}

export interface InstallmentFact {
  principalCents: number;
  dueDate: IsoDate;
  status: string;
  /** First installment of the plan's first rent period. */
  first: boolean;
  /** Date the landlord was paid for the period. Null when the payout is not PAID. */
  frontedOn: IsoDate | null;
  paidOn: IsoDate | null;
  chargedOffOn: IsoDate | null;
}

export interface PlanFact {
  planId: string;
  businessId: string;
  businessName: string;
  industry: string;
  status: string;
  monthlyRentCents: number;
  /** Date the first landlord payout went out. Null when nothing has been fronted. */
  originatedOn: IsoDate | null;
  /** Expected loss per period from the decision's pricing, in basis points of rent. */
  expectedLossBps: number | null;
  /** Rent periods fronted. */
  periodsFronted: number;
  frontedCents: number;
  installments: InstallmentFact[];
}

export interface ExposureFact {
  /** Pool cash plus receivables. */
  capitalCents: number;
  committedCents: number;
  byIndustry: Array<{ industry: string; committedCents: number }>;
  byBusiness: Array<{ businessId: string; businessName: string; committedCents: number }>;
}

export interface BooksFact {
  totalDebitsCents: number;
  totalCreditsCents: number;
  cashCents: number;
  /** When the newest entry on `cash` was written. Null when there is none. */
  lastCashPostingAt: string | null;
  /** When the newest successful collect-installments run (which sweeps) started. */
  lastSweepAt: string | null;
  allowanceCents: number;
  poolCents: number;
  receivables: Array<{
    businessId: string;
    businessName: string;
    /** Balance of the business's receivable account. */
    ledgerCents: number;
    /** Unpaid principal on paid payouts, less credits left by returned payouts. */
    expectedCents: number;
  }>;
  /** Append-only triggers that exist and are enabled, by table name. */
  appendOnlyTriggers: string[];
}

export interface JobFact {
  name: string;
  lastRun: { asOf: IsoDate; ok: boolean | null; error: string | null } | null;
  lastOkAsOf: IsoDate | null;
}

export interface ScreeningFact {
  id: string;
  businessId: string;
  businessName: string;
  partyType: 'BUSINESS' | 'OWNER' | 'LANDLORD';
  partyRef: string;
  result: 'CLEAR' | 'POSSIBLE_MATCH' | 'MATCH';
  cleared: boolean;
  screenedOn: IsoDate;
  leaseChangeId: string | null;
  /** The party is tied to a plan that is not closed. */
  activeParty: boolean;
}

export interface IdentityFact {
  businessId: string;
  businessName: string;
  verificationStatus: string;
  reasons: string[];
  hasOpenPlan: boolean;
}

export interface RetentionFact {
  applicationId: string;
  decidedOn: IsoDate;
  /** The application row is still there. */
  exists: boolean;
}

export interface AdverseActionFact {
  decisionId: string;
  applicationId: string;
  businessName: string;
  outcome: 'DECLINED' | 'COUNTER_OFFER';
  decidedOn: IsoDate;
  noticeSentOn: IsoDate | null;
}

export interface MonitoringInputs {
  asOf: IsoDate;
  leaseChanges: LeaseChangeFact[];
  landlordAccounts: LandlordAccountFact[];
  bankAccounts: BankAccountFact[];
  applications: ApplicationFact[];
  auditEvents: AuditEventFact[];
  debits: DebitFact[];
  exhausted: ExhaustedFact[];
  plans: PlanFact[];
  exposure: ExposureFact;
  books: BooksFact;
  jobs: JobFact[];
  screenings: ScreeningFact[];
  identities: IdentityFact[];
  retention: RetentionFact[];
  adverseActions: AdverseActionFact[];
}
