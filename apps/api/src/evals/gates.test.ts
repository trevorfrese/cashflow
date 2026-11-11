import { describe, expect, it } from 'vitest';

import { makeCustomer } from './fixtures.ts';
import { allGatesPass, evaluateGates, GATE_THRESHOLDS } from './gates.ts';
import { computeMetrics, type PortfolioMetrics } from './metrics.ts';
import type { CustomerResult } from './portfolio.ts';

/**
 * A book built to pass every gate: 200 plans across four grades with bad rates rising from A
 * to D, bads scoring below goods, no losses, fees above costs, and 100 declined applicants
 * including every fraud applicant.
 */
function passingMetrics(): PortfolioMetrics {
  const customers: CustomerResult[] = [];
  const grades = [
    { grade: 'A' as const, score: 90, bads: 1 },
    { grade: 'B' as const, score: 72, bads: 2 },
    { grade: 'C' as const, score: 60, bads: 3 },
    { grade: 'D' as const, score: 48, bads: 5 },
  ];
  for (const g of grades) {
    for (let i = 0; i < 50; i++) {
      customers.push(
        makeCustomer({
          applicantId: `${g.grade}${i}`,
          grade: g.grade,
          score: i < g.bads ? g.score - 3 : g.score,
          bad: i < g.bads,
          payoutCount: 12,
          payoutCents: 1_200_000,
          principalCollectedCents: 1_200_000,
          feesCollectedCents: 24_000,
          outstandingCentDays: 8_400_000,
        }),
      );
    }
  }
  for (let i = 0; i < 100; i++) {
    customers.push(
      makeCustomer({
        applicantId: `x${i}`,
        outcome: 'DECLINED',
        score: 30,
        grade: 'F',
        fraud: i < 25 ? 'bust_out' : null,
      }),
    );
  }
  return computeMetrics({
    label: 'base',
    servicingPolicy: 'test',
    stress: 'base',
    horizonMonths: 12,
    poolStartCents: 10_000_000,
    poolEndCents: 10_000_000,
    poolMinCents: 5_000_000,
    unfundedPayouts: 0,
    unfundedPayoutDays: 0,
    pool: [],
    customers,
  });
}

function gatesWith(change: (base: PortfolioMetrics, mild: PortfolioMetrics) => void) {
  const base = passingMetrics();
  const mild = passingMetrics();
  change(base, mild);
  const gates = evaluateGates({ base, mild });
  return {
    gates,
    failed: gates.filter((g) => !g.pass).map((g) => g.id),
    byId: Object.fromEntries(gates.map((g) => [g.id, g])),
  };
}

describe('gates', () => {
  it('pass on a book built to pass, and report value and threshold for each', () => {
    const { gates, byId } = gatesWith(() => {});
    expect(gates.map((g) => g.id)).toEqual([
      'net_loss_base',
      'net_margin_base',
      'net_margin_mild_stress',
      'bad_rate_monotonic',
      'auc',
      'fraud_approval',
      'pool_funding',
      'approval_floor',
    ]);
    expect(gates.filter((g) => !g.pass)).toEqual([]);
    expect(allGatesPass(gates)).toBe(true);
    expect(byId.net_loss_base).toMatchObject({ value: 0, threshold: 75, comparator: '<=' });
    expect(byId.approval_floor).toMatchObject({ value: 6667, threshold: 3000 });
    expect(byId.auc).toMatchObject({ threshold: 0.7, comparator: '>=', pass: true });
  });

  it('net loss gate sits exactly at 75 bps', () => {
    expect(gatesWith((b) => (b.overall.netLossBps = 75)).failed).toEqual([]);
    expect(gatesWith((b) => (b.overall.netLossBps = 76)).failed).toEqual(['net_loss_base']);
  });

  it('net margin must be strictly positive in base and in mild stress', () => {
    expect(gatesWith((b) => (b.overall.netMarginCents = 0)).failed).toEqual(['net_margin_base']);
    expect(gatesWith((_b, m) => (m.overall.netMarginCents = -1)).failed).toEqual([
      'net_margin_mild_stress',
    ]);
  });

  it('fails rank ordering below 0.70 or when it cannot be measured', () => {
    expect(gatesWith((b) => (b.rankOrdering.auc = 0.699)).failed).toEqual(['auc']);
    expect(gatesWith((b) => (b.rankOrdering.auc = 0.7)).failed).toEqual([]);
    const unmeasured = gatesWith((b) => (b.rankOrdering.auc = null));
    expect(unmeasured.failed).toEqual(['auc']);
    expect(unmeasured.byId.auc!.value).toBeNull();
  });

  it('fails when a better grade is worse than the next by more than the tolerance', () => {
    const { failed, byId } = gatesWith((b) => {
      b.byGrade.A!.badRateBps = b.byGrade.B!.badRateBps + GATE_THRESHOLDS.monotonicToleranceBps + 1;
    });
    expect(failed).toEqual(['bad_rate_monotonic']);
    expect(byId.bad_rate_monotonic!.value).toBe(1);
  });

  it('fails at 5% of fraud applicants approved, passes just under', () => {
    expect(gatesWith((b) => (b.fraud.approvalRateBps = 499)).failed).toEqual([]);
    expect(gatesWith((b) => (b.fraud.approvalRateBps = 500)).failed).toEqual(['fraud_approval']);
  });

  it('fails when the pool could not fund a payout', () => {
    expect(gatesWith((b) => (b.pool.unfundedPayouts = 1)).failed).toEqual(['pool_funding']);
  });

  it('cannot be passed by declining everyone', () => {
    const { failed } = gatesWith((b) => {
      b.overall.approvalRateBps = 0;
      b.overall.volumeCents = 0;
      b.rankOrdering.auc = null;
    });
    expect(failed).toEqual([
      'net_loss_base',
      'net_margin_base',
      'bad_rate_monotonic',
      'auc',
      'approval_floor',
    ]);
    expect(gatesWith((b) => (b.overall.approvalRateBps = 2999)).failed).toEqual(['approval_floor']);
  });
});
