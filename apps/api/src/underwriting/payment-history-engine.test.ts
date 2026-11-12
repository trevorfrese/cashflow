import { describe, expect, it } from 'vitest';

import { decide, type EngineInput } from './engine.ts';
import { summarizePaymentHistory, type PaymentHistoryMonth } from './payment-history.ts';
import { PAYMENT_HISTORY_POLICY_V4, POLICY_V3, POLICY_V4 } from './policy.ts';
import { account, AS_OF, engineInput } from './test-support.ts';

const months = (outcomes: PaymentHistoryMonth['outcome'][]): PaymentHistoryMonth[] =>
  outcomes.map((outcome, i) => {
    const m = String(i + 1).padStart(2, '0');
    return {
      rentPlanId: 'p1',
      kind: 'PASS_THROUGH',
      periodMonth: `2026-${m}`,
      dueDate: `2026-${m}-01`,
      outcome,
    };
  });
const history = (outcomes: PaymentHistoryMonth['outcome'][]) =>
  summarizePaymentHistory(months(outcomes), AS_OF, 12);

/** The parts of a decision an applicant and a plan read. */
const terms = (r: ReturnType<typeof decide>) => ({
  outcome: r.outcome,
  score: r.score,
  grade: r.grade,
  approvedMonthlyLimitCents: r.approvedMonthlyLimitCents,
  feeBps: r.feeBps,
  reasons: r.reasons,
  referTriggers: r.snapshot.referTriggers,
});

/** An input whose version 4 score, without history, is inside [lo, hi]. */
function inputScoring(lo: number, hi: number): EngineInput {
  for (let balance = 0; balance <= 8_000_000; balance += 50_000) {
    for (const costShare of [0.8, 0.82, 0.84, 0.86]) {
      const input = engineInput(account({ costShare }), {
        bankData: {
          transactions: account({ costShare }),
          currentBalanceCents: balance,
          asOf: AS_OF,
        },
      });
      const r = decide(input, POLICY_V4);
      if (r.score !== null && r.score >= lo && r.score <= hi && r.outcome !== 'DECLINED') {
        return input;
      }
    }
  }
  throw new Error(`no fixture scores between ${lo} and ${hi}`);
}

describe('payment history factor (policy version 4)', () => {
  it('is neutral without history: version 4 decides exactly as version 3', () => {
    const inputs: EngineInput[] = [
      engineInput(account()),
      engineInput(account(), { timeInBusinessMonths: 2 }),
      engineInput(account({ costShare: 0.95 })),
      engineInput(account(), { bankData: null }),
      engineInput(account(), { paymentHistory: history([]) }),
    ];
    for (const input of inputs) {
      const v3 = decide(input, POLICY_V3);
      const v4 = decide(input, POLICY_V4);
      expect(terms(v4)).toEqual(terms(v3));
      expect(v4.snapshot.paymentHistory).toBeNull();
      expect(v4.reasons.map((r) => r.code)).not.toContain('PAYMENT_HISTORY');
    }
  });

  it('adds points for a run of on time months and stores the factor in the snapshot', () => {
    const input = engineInput(account());
    const without = decide(input, POLICY_V4);
    const withHistory = decide(
      { ...input, paymentHistory: history(['ON_TIME', 'ON_TIME', 'ON_TIME']) },
      POLICY_V4,
    );
    const bonus = 3 * PAYMENT_HISTORY_POLICY_V4.pointsPerOnTimeMonth;
    expect(withHistory.score).toBe(Math.min(100, without.score! + bonus));
    expect(withHistory.snapshot.paymentHistory).toMatchObject({
      baseScore: without.score,
      factor: { points: bonus, impact: 'POSITIVE' },
      summary: { currentOnTimeStreak: 3, months: 3 },
    });
    expect(withHistory.reasons.find((r) => r.code === 'PAYMENT_HISTORY')?.impact).toBe('POSITIVE');
  });

  it('takes points for missed months and can turn an approval into a decline', () => {
    const input = inputScoring(55, 59);
    expect(decide(input, POLICY_V4).outcome).toBe('APPROVED');
    const missed = decide(
      { ...input, paymentHistory: history(['ON_TIME', 'MISSED', 'MISSED']) },
      POLICY_V4,
    );
    expect(missed.outcome).toBe('DECLINED');
    expect(missed.reasons.map((r) => r.code)).toContain('SCORE_BELOW_MINIMUM');
  });

  it('never sends an application to a reviewer that would not have gone without it', () => {
    // A late month takes a base score of 55 to 59 into the band just above the cutoff. The
    // band referral reads the score before payment history, so it is still decided.
    const approved = inputScoring(55, 59);
    const late = decide({ ...approved, paymentHistory: history(['LATE']) }, POLICY_V4);
    expect(late.score!).toBeLessThan(55);
    expect(late.snapshot.referTriggers).not.toContain('SCORE_NEAR_CUTOFF');
    expect(late.outcome).not.toBe('REFER');
  });

  it('does not take a referral away either: the band reads the score before the factor', () => {
    const nearCutoff = inputScoring(50, 54);
    const base = decide(nearCutoff, POLICY_V4);
    expect(base.snapshot.referTriggers).toContain('SCORE_NEAR_CUTOFF');
    const helped = decide(
      { ...nearCutoff, paymentHistory: history(['ON_TIME', 'ON_TIME', 'ON_TIME', 'ON_TIME']) },
      POLICY_V4,
    );
    expect(helped.score!).toBeGreaterThanOrEqual(55);
    expect(helped.snapshot.referTriggers).toContain('SCORE_NEAR_CUTOFF');
  });

  it('is ignored by version 3', () => {
    const input = { ...engineInput(account()), paymentHistory: history(['MISSED', 'MISSED']) };
    expect(terms(decide(input, POLICY_V3))).toEqual(
      terms(decide(engineInput(account()), POLICY_V3)),
    );
  });
});
