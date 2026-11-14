import { z } from 'zod';

import { PrincipalReason } from '../adverse-action/principal';
import { CreditGrade } from './underwriting';
import { Bps, Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Adverse action notices and decision explanations, as the applicant and the operator see
 * them. See `apps/api/UNDERWRITING.md`, "Reasons and adverse action notices".
 */

/** Why a notice was sent. */
export const AdverseActionNoticeKind = z.enum([
  /** The application was declined, by the engine or a reviewer. */
  'DECLINE',
  /** A counter offer was declined by the applicant, or expired without being used. */
  'COUNTER_OFFER_NOT_ACCEPTED',
  /** A notice of incompleteness: what is missing, and by when (12 CFR 1002.9(c)(2)). */
  'INCOMPLETE',
  /** The application stayed incomplete past that date and was closed. */
  'INCOMPLETE_DECLINED',
  /**
   * A periodic review stopped the advances on a running plan: an unfavorable change to
   * existing credit (12 CFR 1002.2(c)(1)(ii)).
   */
  'PLAN_FROZEN',
]);
export type AdverseActionNoticeKind = z.infer<typeof AdverseActionNoticeKind>;

/**
 * The short reference printed on a notice and shown beside it in the app: the last six
 * characters of the application id, uppercased. Enough for support to find the application,
 * without putting a raw database id in front of the owner.
 */
export function noticeReference(applicationId: string): string {
  return applicationId.slice(-6).toUpperCase();
}

export const NoticeChannel = z.enum(['IN_APP']);
export type NoticeChannel = z.infer<typeof NoticeChannel>;

export const AdverseActionNoticeView = z.object({
  id: Id,
  applicationId: Id,
  /** The reference number printed on the notice (`noticeReference`). */
  reference: z.string(),
  decisionId: Id,
  kind: AdverseActionNoticeKind,
  /** A notice of incompleteness is not itself an adverse action. */
  isAdverseAction: z.boolean(),
  title: z.string(),
  principalReasons: z.array(PrincipalReason),
  /** The full notice exactly as rendered and stored. */
  text: z.string(),
  statementVersion: z.string(),
  /** The date the action was taken or the notice became due. */
  actionOn: IsoDateSchema,
  /** The date by which the notice had to be delivered. */
  deadlineOn: IsoDateSchema,
  /** For a notice of incompleteness: the date to provide the information by. */
  respondBy: IsoDateSchema.nullable(),
  deliveredAt: IsoDateTimeSchema,
  channel: NoticeChannel,
  /** Delivered after its deadline. */
  late: z.boolean(),
});
export type AdverseActionNoticeView = z.infer<typeof AdverseActionNoticeView>;

/** How the applicant sees the outcome. A counter offer is an approval for less. */
export const ExplanationOutcome = z.enum([
  'APPROVED',
  'COUNTER_OFFER',
  'DECLINED',
  'IN_REVIEW',
  'NEEDS_INFO',
  'NOT_SUBMITTED',
]);
export type ExplanationOutcome = z.infer<typeof ExplanationOutcome>;

export const FactorStatus = z.enum(['HELPING', 'NEUTRAL', 'HURTING']);
export type FactorStatus = z.infer<typeof FactorStatus>;

export const ExplanationFactor = z.object({
  code: z.string(),
  label: z.string(),
  status: FactorStatus,
  /** What the factor measures. */
  measures: z.string(),
  /** What we found, in plain words. */
  detail: z.string(),
});
export type ExplanationFactor = z.infer<typeof ExplanationFactor>;

export const ExplanationCheck = z.object({
  code: z.string(),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type ExplanationCheck = z.infer<typeof ExplanationCheck>;

export const ExplanationDataSource = z.object({
  kind: z.enum(['BANK', 'COMMERCE']),
  /** The bank's name and account mask, or the platform's name. */
  name: z.string(),
  /** The date of the data the decision read. Null when no pull is recorded. */
  dataAsOf: IsoDateSchema.nullable(),
});
export type ExplanationDataSource = z.infer<typeof ExplanationDataSource>;

export const DecisionExplanation = z.object({
  applicationId: Id,
  outcome: ExplanationOutcome,
  decidedAt: IsoDateTimeSchema.nullable(),
  headline: z.string(),
  summary: z.string(),
  /**
   * The score and grade, only on an approval or a counter offer. Never on a decline or a
   * referral, where a high score beside a decline would mislead.
   */
  score: z.object({ value: z.number().int().min(0).max(100), grade: CreditGrade }).nullable(),
  /** Why, on a decline or a counter offer, most important first. Empty otherwise. */
  principalReasons: z.array(PrincipalReason),
  /** What we need, on a request for information. Empty otherwise. */
  requestedInformation: z.array(PrincipalReason),
  /** Every scorecard factor, in catalog order. Empty when the application was not scored. */
  factors: z.array(ExplanationFactor),
  /** The rules that ran and whether each passed. Empty when the rules did not run. */
  checks: z.array(ExplanationCheck),
  dataSources: z.array(ExplanationDataSource),
  /** On an approval or a counter offer. */
  terms: z
    .object({
      requestedMonthlyRentCents: Cents,
      approvedMonthlyLimitCents: Cents,
      feeBps: Bps,
      installmentsPerMonth: z.number().int().min(1).max(4),
      why: z.string(),
    })
    .nullable(),
  /** What happens next on a referral: who decides, and by when. */
  nextSteps: z.object({ text: z.string(), expectedBy: IsoDateSchema.nullable() }).nullable(),
  /** A counter offer the applicant can still decline (and so receive a notice). */
  canDeclineOffer: z.boolean(),
  notices: z.array(
    z.object({
      id: Id,
      kind: AdverseActionNoticeKind,
      title: z.string(),
      deliveredAt: IsoDateTimeSchema,
    }),
  ),
});
export type DecisionExplanation = z.infer<typeof DecisionExplanation>;
