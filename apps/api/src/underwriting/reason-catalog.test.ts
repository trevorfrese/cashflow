import { readFileSync } from 'node:fs';

import { catalogEntry, findJargon, type DecisionReason } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { drawPopulation } from '../evals/population.ts';
import { underwrite } from '../evals/portfolio.ts';
import { decide, type EngineInput, type EngineResult } from './engine.ts';
import { NO_EXPOSURE_CONTEXT } from './exposure.ts';
import { account, engineInput } from './test-support.ts';

/**
 * Every reason the engine can give is in the reason catalog, and every reason an applicant
 * reads is in plain words. Two ways round: the source is scanned for every code literal the
 * engine, the scorecard and the review service can emit (complete, but blind to text), and
 * the engine is driven across a synthetic population with a raised share of fraud (real
 * text, the paths the population reaches).
 */

const SOURCES = [
  'engine.ts',
  'scorecard.ts',
  '../services/reviews.ts',
  '../veracity/rules.ts',
] as const;

function codeLiterals(file: string): string[] {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const found = new Set<string>();
  for (const re of [/reason\(\s*'([A-Z_]+)'/g, /code: '([A-Z_]+)'/g, /\?\s*'([A-Z_]+)'\s*$/gm]) {
    for (const m of text.matchAll(re)) found.add(m[1]!);
  }
  return [...found];
}

/** Codes the veracity rules carry that are finding codes, not reasons: mapped in engine.ts. */
const FINDING_CODES = new Set(
  readFileSync(new URL('../veracity/rules.ts', import.meta.url), 'utf8')
    .match(/^\s{2}([A-Z_]+): \{/gm)
    ?.map((l) => l.trim().replace(/: \{$/, '')) ?? [],
);

function checkResult(result: EngineResult, input: Pick<EngineInput, 'requestedMonthlyRentCents'>) {
  for (const r of result.reasons) {
    expect(catalogEntry(r.code), `reason ${r.code} is not in the catalog`).toBeDefined();
    expect(findJargon(r.message), `${r.code}: "${r.message}"`).toBeNull();
  }
  const counterOffer =
    result.outcome === 'APPROVED' &&
    (result.approvedMonthlyLimitCents ?? 0) < input.requestedMonthlyRentCents;
  if (result.outcome === 'DECLINED' || counterOffer || result.outcome === 'NEEDS_INFO') {
    expect(result.principalReasons.length, `${result.outcome} without a reason`).toBeGreaterThan(0);
  } else {
    expect(result.principalReasons).toEqual([]);
  }
  expect(result.principalReasons.length).toBeLessThanOrEqual(4);
  for (const p of result.principalReasons) {
    const entry = catalogEntry(p.code);
    expect(entry?.adverseActionEligible, p.code).toBe(true);
    for (const text of [p.title, p.text, p.guidance]) {
      expect(findJargon(text), `${p.code}: "${text}"`).toBeNull();
    }
  }
}

describe('reason catalog coverage', () => {
  it('has every reason code the engine, scorecard and review service write', () => {
    const missing: string[] = [];
    for (const file of SOURCES) {
      for (const code of codeLiterals(file)) {
        if (FINDING_CODES.has(code)) continue;
        if (!catalogEntry(code)) missing.push(`${file}: ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every engine decision across a population catalog reasons in plain words', () => {
    const emitted = new Map<string, number>();
    const principal = new Map<string, number>();
    const outcomes = new Map<string, number>();
    for (const seed of ['reasons-1', 'reasons-2']) {
      for (const applicant of drawPopulation({ n: 300, seed, fraudShareBps: 3000 })) {
        const { decision } = underwrite(applicant, {
          decide: (input) => decide(input),
          stress: null,
          startDate: applicant.applicationDate,
          stripVeracity: false,
        });
        checkResult(decision, { requestedMonthlyRentCents: applicant.requestedRentCents });
        outcomes.set(decision.outcome, (outcomes.get(decision.outcome) ?? 0) + 1);
        for (const r of decision.reasons) emitted.set(r.code, (emitted.get(r.code) ?? 0) + 1);
        for (const p of decision.principalReasons) {
          principal.set(p.code, (principal.get(p.code) ?? 0) + 1);
        }
      }
    }
    // The population reaches every outcome and a broad set of reasons.
    expect([...outcomes.keys()].sort()).toEqual(['APPROVED', 'DECLINED', 'NEEDS_INFO', 'REFER']);
    expect(emitted.size).toBeGreaterThan(20);
    expect(principal.has('SCORE_BELOW_MINIMUM')).toBe(false);
  });

  it('gives the paths the population does not reach catalog reasons too', () => {
    const base = engineInput(account());
    const cases: EngineInput[] = [
      // A landlord account that is the applicant's own, and a failed identity check.
      { ...base, integrityContext: { landlordAccountIsApplicantAccount: true } },
      {
        ...base,
        integrityContext: {
          identity: {
            verification: 'FAILED',
            verificationReasons: ['NOT_FOUND'],
            screening: 'CLEAR',
            openHits: 0,
          },
        },
      },
      // The ladder already full for this business.
      {
        ...base,
        exposureContext: {
          ...NO_EXPOSURE_CONTEXT,
          businessCommittedCents: 4_000_000,
        },
      },
      // Too new, and a rent far above what the account shows.
      { ...base, timeInBusinessMonths: 3 },
      { ...base, requestedMonthlyRentCents: base.requestedMonthlyRentCents * 4 },
      // A tiny rent the fee cannot serve.
      { ...base, requestedMonthlyRentCents: 20_000 },
      // No bank at all.
      { ...base, bankData: null },
    ];
    for (const input of cases) checkResult(decide(input), input);
  });

  it('keeps the reasons a reviewer writes in the catalog', () => {
    const headline: DecisionReason[] = [
      { code: 'APPROVED_AFTER_REVIEW', message: 'x', impact: 'POSITIVE' },
      { code: 'DECLINED_AFTER_REVIEW', message: 'x', impact: 'NEGATIVE' },
      { code: 'INFO_REQUESTED', message: 'x', impact: 'INFO' },
    ];
    for (const r of headline) expect(catalogEntry(r.code)).toBeDefined();
  });
});
