import type { CustomerResult } from './portfolio.ts';
import { FRAUD_TYPES } from './population.ts';
import { HONEST_TAGS } from './veracity-sim.ts';

/**
 * What the veracity checks did, measured on one run: detection by fraud archetype and by
 * check, and what they cost honest applicants, overall, by check, and by the honest messiness
 * that was simulated. Rates are basis points.
 */

const bps = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 10_000) / d));

export interface EffectCounts {
  applicants: number;
  knockout: number;
  refer: number;
  needsInfo: number;
  /** Knocked out or referred: what the gate counts. */
  adverse: number;
  adverseRateBps: number;
  needsInfoRateBps: number;
  /** Knocked out, referred or asked for information. */
  anyRateBps: number;
  /** Affected, and on the same data without the checks would have had a usable approval. */
  lostUsable: number;
}

export interface VeracityMetrics {
  honest: EffectCounts & {
    /** Honest applicants on whom each finding fired, and on how many it was adverse. */
    byCode: Record<string, { fired: number; adverse: number; needsInfo: number }>;
    byTag: Record<string, EffectCounts>;
  };
  fraud: Record<
    string,
    {
      applicants: number;
      approved: number;
      /** Applicants on whom each finding fired. */
      byCode: Record<string, number>;
      /** Applicants on whom any finding changed the outcome. */
      caught: number;
      byEffect: { knockout: number; refer: number; needsInfo: number };
    }
  >;
}

function effects(list: readonly CustomerResult[]): EffectCounts {
  const knockout = list.filter((c) => c.veracityEffect === 'KNOCKOUT').length;
  const refer = list.filter((c) => c.veracityEffect === 'REFER').length;
  const needsInfo = list.filter((c) => c.veracityEffect === 'NEEDS_INFO').length;
  return {
    applicants: list.length,
    knockout,
    refer,
    needsInfo,
    adverse: knockout + refer,
    adverseRateBps: bps(knockout + refer, list.length),
    needsInfoRateBps: bps(needsInfo, list.length),
    anyRateBps: bps(knockout + refer + needsInfo, list.length),
    lostUsable: list.filter(
      (c) => c.veracityEffect !== null && c.veracityEffect !== 'REFER' && c.usableWithoutVeracity,
    ).length,
  };
}

export function veracityMetrics(customers: readonly CustomerResult[]): VeracityMetrics {
  const honest = customers.filter((c) => c.fraud === null);
  const byCode: VeracityMetrics['honest']['byCode'] = {};
  for (const c of honest) {
    for (const code of new Set(c.veracityCodes)) {
      const cell = (byCode[code] ??= { fired: 0, adverse: 0, needsInfo: 0 });
      cell.fired += 1;
      if (c.veracityEffect === 'KNOCKOUT' || c.veracityEffect === 'REFER') cell.adverse += 1;
      if (c.veracityEffect === 'NEEDS_INFO') cell.needsInfo += 1;
    }
  }
  const byTag: Record<string, EffectCounts> = {};
  for (const tag of HONEST_TAGS) {
    const list = honest.filter((c) => c.veracityTags.includes(tag));
    if (list.length > 0) byTag[tag] = effects(list);
  }
  const fraud: VeracityMetrics['fraud'] = {};
  for (const type of FRAUD_TYPES) {
    const list = customers.filter((c) => c.fraud === type);
    const codes: Record<string, number> = {};
    for (const c of list)
      for (const code of new Set(c.veracityCodes)) codes[code] = (codes[code] ?? 0) + 1;
    fraud[type] = {
      applicants: list.length,
      approved: list.filter((c) => c.outcome === 'APPROVED').length,
      byCode: codes,
      caught: list.filter((c) => c.veracityEffect !== null).length,
      byEffect: {
        knockout: list.filter((c) => c.veracityEffect === 'KNOCKOUT').length,
        refer: list.filter((c) => c.veracityEffect === 'REFER').length,
        needsInfo: list.filter((c) => c.veracityEffect === 'NEEDS_INFO').length,
      },
    };
  }
  return { honest: { ...effects(honest), byCode, byTag }, fraud };
}

/** Bad rate of a set of counterfactual plans. */
export interface CounterfactualCell {
  plans: number;
  bad: number;
  badRateBps: number;
}

export function counterfactualCell(customers: readonly CustomerResult[]): CounterfactualCell {
  const funded = customers.filter((c) => c.payoutCount > 0);
  const bad = funded.filter((c) => c.bad).length;
  return { plans: funded.length, bad, badRateBps: bps(bad, funded.length) };
}
