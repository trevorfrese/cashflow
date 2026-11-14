import { describe, expect, it } from 'vitest';

import { decide } from './engine.ts';
import { PD_TABLE_V2 } from './pd-table.ts';
import { POLICY_V4, POLICY_V5 } from './policy.ts';
import { pdBandFor, pdEquivalentScore, scaledPdBps } from './pricing.ts';
import { account, engineInput } from './test-support.ts';

describe('graduate pricing (version 5)', () => {
  it('scales the table PD and holds it to 100%', () => {
    expect(scaledPdBps(PD_TABLE_V2, 97)).toBe(pdBandFor(PD_TABLE_V2, 97).pdBps);
    expect(scaledPdBps(PD_TABLE_V2, 97, 25_000)).toBe(
      Math.round(pdBandFor(PD_TABLE_V2, 97).pdBps * 2.5),
    );
    expect(scaledPdBps(PD_TABLE_V2, 50, 1_000_000)).toBe(10_000);
  });

  it('reads a PD back as the score a first time applicant would need to carry it', () => {
    // The table's own PD at a score maps to a score in the same band or above it, capped.
    for (const score of [55, 70, 85, 97]) {
      const band = pdBandFor(PD_TABLE_V2, score);
      expect(pdEquivalentScore(PD_TABLE_V2, band.pdBps, score)).toBe(score);
    }
    // A higher PD reads as a lower score, never a higher one.
    const doubled = pdEquivalentScore(PD_TABLE_V2, scaledPdBps(PD_TABLE_V2, 97, 25_000), 97);
    expect(doubled).toBeLessThan(97);
    expect(pdBandFor(PD_TABLE_V2, doubled).pdBps).toBeGreaterThanOrEqual(
      scaledPdBps(PD_TABLE_V2, 97, 25_000),
    );
  });

  it('prices a graduation review on the graduate PD, and a first time applicant as before', () => {
    const input = engineInput(account());
    const firstTime5 = decide(input, POLICY_V5);
    const firstTime4 = decide(input, POLICY_V4);
    // Version 5 decides a first time applicant exactly as version 4.
    expect(firstTime5.outcome).toBe('APPROVED');
    expect([firstTime5.feeBps, firstTime5.approvedMonthlyLimitCents, firstTime5.grade]).toEqual([
      firstTime4.feeBps,
      firstTime4.approvedMonthlyLimitCents,
      firstTime4.grade,
    ]);
    expect(firstTime5.snapshot.graduatePricing).toBeNull();

    const graduate = decide({ ...input, graduation: true }, POLICY_V5);
    const g = graduate.snapshot.graduatePricing!;
    expect(g.pdMultiplierBps).toBe(25_000);
    expect(g.pdBps).toBe(scaledPdBps(PD_TABLE_V2, graduate.score!, 25_000));
    expect(graduate.snapshot.pricing!.pdBps).toBe(g.pdBps);
    expect(g.termsScore).toBeLessThanOrEqual(graduate.score!);
    // The score and grade on the decision are the scorecard's; the fee is at least as high.
    expect(graduate.score).toBe(firstTime5.score);
    expect(graduate.grade).toBe(firstTime5.grade);
    expect(graduate.feeBps!).toBeGreaterThanOrEqual(firstTime5.feeBps!);
    expect(graduate.feeBps!).toBeGreaterThanOrEqual(POLICY_V5.pricing[g.termsGrade].feeBps);

    // Version 4 ignores the flag: graduates at first time terms.
    const v4Graduate = decide({ ...input, graduation: true }, POLICY_V4);
    expect(v4Graduate.feeBps).toBe(firstTime4.feeBps);
    expect(v4Graduate.snapshot.graduatePricing).toBeNull();
  });
});
