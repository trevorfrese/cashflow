import { z } from 'zod';

import type { DecisionOutcome } from '../enums';
import type { DecisionReason, ReasonImpact } from '../schemas/underwriting';
import { catalogEntry, FACTOR_CODES } from './catalog';

/**
 * Principal reasons: the few reasons an applicant is told on a decline, a counter offer, or a
 * notice of incompleteness, in the order that explains the outcome best.
 *
 * Regulation B asks for the specific principal reasons for adverse action (12 CFR
 * 1002.9(b)(2)); its commentary says more than four is not likely to be helpful. So:
 *
 *   1. Rules that declined on their own, in the order the engine applied them (trust checks
 *      first, then the credit rules, then capacity and price). Each one alone was enough.
 *   2. Then the scorecard factors that lost the most points against their full marks, which
 *      is what kept the score from the approve threshold. A factor a rule above already
 *      restates (overdrafts and account conduct) is not listed twice. Ties go to catalog
 *      order, so the result is deterministic.
 *   3. "Score below the minimum" is never a principal reason: it is not specific. It is
 *      replaced by the factors behind it.
 *
 * Every reason is drawn from the catalog. The text is the engine's own, with the
 * applicant's numbers, when it has one; otherwise the catalog's.
 */

export const MAX_PRINCIPAL_REASONS = 4;

export const PrincipalReason = z.object({
  code: z.string(),
  /** Short plain label. */
  title: z.string(),
  /** What happened, specifically, in plain words. */
  text: z.string(),
  /** What would change the outcome. */
  guidance: z.string(),
});
export type PrincipalReason = z.infer<typeof PrincipalReason>;

/** A scorecard factor's points. Read from the engine at decision time; never shown. */
export interface FactorPoints {
  code: string;
  points: number;
  maxPoints: number;
  impact: ReasonImpact;
}

/** The principal reason for a catalog code, with the specific text when one is given. */
export function principalReason(code: string, specificText?: string | null): PrincipalReason {
  const entry = catalogEntry(code);
  if (!entry) throw new Error(`Reason ${code} is not in the reason catalog`);
  return {
    code,
    title: entry.title,
    text: specificText && specificText.trim() !== '' ? specificText : entry.applicantText,
    guidance: entry.guidance,
  };
}

export interface PrincipalReasonInput {
  outcome: DecisionOutcome;
  /** Approved for less than the rent requested. */
  counterOffer: boolean;
  /** The decision's reasons, in the order the engine produced them. */
  reasons: readonly DecisionReason[];
  /**
   * The scorecard factors with their points. Without them (a decision stored before the
   * points were kept) factors are ordered as the engine listed them, hurting first.
   */
  factors?: readonly FactorPoints[] | null;
  max?: number;
}

export function selectPrincipalReasons(input: PrincipalReasonInput): PrincipalReason[] {
  const max = input.max ?? MAX_PRINCIPAL_REASONS;
  const messages = new Map(input.reasons.map((r) => [r.code, r.message]));
  const out: PrincipalReason[] = [];
  const add = (code: string) => {
    if (out.length >= max || out.some((r) => r.code === code)) return;
    out.push(principalReason(code, messages.get(code)));
  };

  if (input.outcome === 'NEEDS_INFO') {
    for (const r of input.reasons) {
      const e = catalogEntry(r.code);
      if (e?.kind === 'NEEDS_INFO' && e.adverseActionEligible) add(r.code);
    }
    return out;
  }

  const declined = input.outcome === 'DECLINED';
  const counter = input.outcome === 'APPROVED' && input.counterOffer;
  if (!declined && !counter) return [];

  const covered = new Set<string>();
  if (declined) {
    for (const r of input.reasons) {
      const e = catalogEntry(r.code);
      if (!e || e.kind !== 'DECLINE' || !e.adverseActionEligible) continue;
      add(r.code);
      if (e.relatedFactor) covered.add(e.relatedFactor);
    }
  } else {
    add('LIMIT_BELOW_REQUEST');
  }

  for (const code of rankedFactors(input, declined)) {
    if (!covered.has(code)) add(code);
  }

  // Every decline has a specific reason. If nothing above produced one (no rule fired and
  // no factor lost points, which the engine cannot do), fall back to the factors that
  // were listed at all, so the applicant is never told only "score".
  if (declined && out.length === 0) {
    for (const r of input.reasons) if (FACTOR_CODES.includes(r.code)) add(r.code);
  }
  return out;
}

/**
 * Factors that cost points, most points lost first. On a decline every factor below full
 * marks that is not helping counts; on a counter offer only the ones hurting.
 */
function rankedFactors(input: PrincipalReasonInput, declined: boolean): string[] {
  const order = (code: string) => FACTOR_CODES.indexOf(code);
  const eligible = (impact: ReasonImpact) =>
    declined ? impact !== 'POSITIVE' : impact === 'NEGATIVE';
  if (input.factors && input.factors.length > 0) {
    return input.factors
      .filter((f) => FACTOR_CODES.includes(f.code))
      .map((f) => ({ ...f, lost: f.maxPoints - f.points }))
      .filter((f) => f.lost > 0 && eligible(f.impact))
      .sort((a, b) => b.lost - a.lost || order(a.code) - order(b.code))
      .map((f) => f.code);
  }
  const rank = { NEGATIVE: 0, INFO: 1, POSITIVE: 2 } as const;
  return input.reasons
    .filter((r) => FACTOR_CODES.includes(r.code) && eligible(r.impact))
    .sort((a, b) => rank[a.impact] - rank[b.impact] || order(a.code) - order(b.code))
    .map((r) => r.code);
}

/**
 * A reviewer's picks as principal reasons. Codes must be in the catalog; the specific text
 * from the decision under review is used when it lists the same code.
 */
export function principalReasonsFromCodes(
  codes: readonly string[],
  reasons: readonly DecisionReason[] = [],
  max: number = MAX_PRINCIPAL_REASONS,
): PrincipalReason[] {
  const messages = new Map(reasons.map((r) => [r.code, r.message]));
  const seen = new Set<string>();
  const out: PrincipalReason[] = [];
  for (const code of codes) {
    if (seen.has(code) || out.length >= max) continue;
    seen.add(code);
    out.push(principalReason(code, messages.get(code)));
  }
  return out;
}
