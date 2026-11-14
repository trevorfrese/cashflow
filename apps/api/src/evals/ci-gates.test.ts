import { describe, expect, it } from 'vitest';

import { BASELINE_SERVICING_POLICY } from '../servicing/policy.ts';
import { CURRENT_POLICY, POLICY_V1 } from '../underwriting/policy.ts';
import { GATE_THRESHOLDS } from './gates.ts';
import { evaluate, GATED_CONFIG } from './run.ts';

/**
 * The gates on every push: a small fixed seed evaluation of the policy in force, judged by
 * the same gates as the default run, with the same thresholds. It is a smoke test of the
 * policy, not a replacement for the default run: the full strict evaluation (5 seeds of 2,000
 * applicants) runs nightly, on demand, and on any pull request that touches underwriting,
 * servicing, pricing or the evals (`.github/workflows/eval.yml`), and it is what change
 * control reads (`apps/api/CREDIT_POLICY.md`, "Change control").
 *
 * Small samples are noisy, so this run is sized and seeded to sit well inside every gate
 * under the policy in force. A change that pushes it over is a change the full run has to
 * judge before it ships. A negative control checks the gates still bite: the launch policy
 * under the old servicing fails the loss gates on the same applicants.
 */
const CI_RUN = { n: 600, seeds: ['ci-1', 'ci-2'], horizonMonths: 12 } as const;

describe('portfolio gates on a fixed seed sample', () => {
  const evaluation = evaluate({ ...CI_RUN, comparisons: [] });
  const byId = new Map(evaluation.gates.map((g) => [g.id, g]));

  it('judges the policy in force under the gated servicing, on every gate', () => {
    expect(evaluation.run.policyVersion).toBe(CURRENT_POLICY.version);
    expect(evaluation.run.gated).toBe(GATED_CONFIG.name);
    expect(evaluation.gates.map((g) => g.id).sort()).toEqual(
      [
        'adverse_action_reasons',
        'approval_floor',
        'auc',
        'bad_rate_monotonic',
        'fraud_approval',
        'net_loss_base',
        'net_margin_base',
        'net_margin_mild_stress',
        'pool_funding',
        'refer_rate',
        'veracity_honest_adverse',
      ].sort(),
    );
    // Every gate measured something on every seed: a gate that cannot be measured fails.
    for (const g of evaluation.gates) {
      expect(g.value, g.id).not.toBeNull();
      expect(g.min, g.id).not.toBeNull();
    }
  });

  it('passes every gate at the thresholds the default run uses', () => {
    const failed = evaluation.gates.filter((g) => !g.pass);
    expect(failed.map((g) => `${g.id}=${g.value} (${g.comparator} ${g.threshold})`)).toEqual([]);
    // The thresholds are the gates', not a looser copy.
    expect(byId.get('net_loss_base')!.threshold).toBe(GATE_THRESHOLDS.maxNetLossBps);
    expect(byId.get('auc')!.threshold).toBe(GATE_THRESHOLDS.minAuc);
    expect(byId.get('refer_rate')!.threshold).toBe(GATE_THRESHOLDS.maxReferRateBps);
    expect(byId.get('approval_floor')!.threshold).toBe(GATE_THRESHOLDS.minApprovalRateBps);
  });

  it('lends enough for the gates to mean something', () => {
    const o = evaluation.base.overall;
    // A policy can pass the loss gates by not lending. This one funds plans, some go bad,
    // and the score is judged on applicants it declined as well.
    expect(o.plans).toBeGreaterThan(200);
    expect(o.badRateBps).toBeGreaterThan(0);
    expect(evaluation.throughTheDoor.pooled.honest.bads).toBeGreaterThan(20);
    expect(evaluation.base.passThrough?.stats.plans ?? 0).toBeGreaterThan(0);
  });

  it('fails the launch policy under the old servicing on the same applicants', () => {
    const launch = evaluate({
      ...CI_RUN,
      comparisons: [],
      gated: {
        name: 'v1_baseline',
        description: 'Negative control.',
        policy: POLICY_V1,
        servicing: BASELINE_SERVICING_POLICY,
        withMild: true,
      },
    });
    const failed = new Set(launch.gates.filter((g) => !g.pass).map((g) => g.id));
    expect(failed.has('net_loss_base')).toBe(true);
    expect(failed.has('fraud_approval')).toBe(true);
  });
}, 300_000);
