import { describe, expect, it } from 'vitest';

import { markdownTable, renderBaseline, renderJson, renderMarkdown, stableJson } from './report.ts';
import { POLICY_VERSION } from '../underwriting/policy.ts';
import { CHALLENGERS, evaluate } from './run.ts';

describe('evaluation and report', () => {
  const options = { n: 120, seeds: ['report', 'report-2'], horizonMonths: 4 };
  const evaluation = evaluate({ ...options, challengers: CHALLENGERS });

  it('gates the current policy under standard servicing, on every seed', () => {
    expect(evaluation.run).toMatchObject({
      seeds: ['report', 'report-2'],
      policyVersion: POLICY_VERSION,
      servicingPolicy: 'standard',
    });
    expect(evaluation.baseBySeed).toHaveLength(2);
    expect(evaluation.baseBySeed.map((m) => m.overall.applicants)).toEqual([120, 120]);
    // Tables pool the seeds into one book.
    expect(evaluation.base.overall.applicants).toBe(240);
    expect(evaluation.base.servicingPolicy).toBe('standard');
    expect(evaluation.mild.stress).toBe('mild');
    expect(evaluation.severe.stress).toBe('severe');
    expect(evaluation.gates).toHaveLength(9);
    for (const g of evaluation.gates) expect(typeof g.pass).toBe('boolean');
  });

  it('runs the comparison configurations on the same applicants', () => {
    expect(evaluation.comparisons.map((c) => [c.name, c.policyVersion, c.servicingPolicy])).toEqual(
      [
        ['v1_baseline', 'cashflow-v1', 'baseline'],
        ['v1_standard', 'cashflow-v1', 'standard'],
        ['v2_baseline', POLICY_VERSION, 'baseline'],
      ],
    );
    const [v1Baseline, v1Standard, v2Baseline] = evaluation.comparisons;
    expect(v1Baseline!.gates).toHaveLength(9);
    expect(v1Standard!.gates).toBeNull();
    expect(v2Baseline!.gates).toHaveLength(9);
    // Servicing does not change who the launch policy approves.
    expect(v1Standard!.base.overall.approved).toBe(v1Baseline!.base.overall.approved);
    // The launch policy never refers.
    expect(v1Baseline!.base.overall.referred).toBe(0);
    for (const c of evaluation.comparisons) expect(c.base.overall.applicants).toBe(240);
  });

  it('runs the challenger against the gated configuration', () => {
    expect(evaluation.challengers.map((c) => c.name)).toEqual(['cutoff_55']);
    // A higher cutoff can only remove approvals.
    expect(evaluation.challengers[0]!.swapSet.swapIn.count).toBe(0);
  });

  it('renders deterministic output with every section and no em dashes', () => {
    const md = renderMarkdown(evaluation);
    expect(renderMarkdown(evaluate(options))).toBe(
      renderMarkdown({ ...evaluation, challengers: [] }),
    );
    for (const heading of [
      '## Gates (Balanced risk appetite)',
      '## What underwriting bought and what servicing bought',
      '## Swap sets against the earlier configurations',
      '## Headline (gated configuration, base case, seeds pooled)',
      '## By grade (base case)',
      '## Calibration: expected against realized (base case)',
      '## By archetype (base case)',
      '## By archetype, before and after',
      '## Stress',
      '## Capital pool by month (base case, seed `report`)',
      '## Challengers (not gated)',
      '## What this can and cannot tell you',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('v2_standard (gated)');
    expect(md).toContain('At most 5% of applicants referred to a reviewer');
    const json = JSON.parse(renderJson(evaluation));
    const baseline = JSON.parse(renderBaseline(evaluation));
    expect(json.scenarios.base.overall.applicants).toBe(240);
    expect(json.bySeed).toHaveLength(2);
    expect(Object.keys(baseline.configurations)).toEqual([
      'v1_baseline',
      'v1_standard',
      'v2_baseline',
      'v2_standard',
    ]);
    expect(baseline.configurations.v2_standard.gated).toBe(true);
    expect(baseline.configurations.v2_standard.gates).toHaveLength(9);
    expect(baseline.configurations.v1_baseline.gates).toHaveLength(9);
    expect(baseline.configurations.v2_standard.headline.base.netLossBps).toBe(
      evaluation.base.overall.netLossBps,
    );
    for (const text of [md, renderJson(evaluation), renderBaseline(evaluation)])
      expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it('a single seed run judges that seed alone', () => {
    const single = evaluate({ n: 80, seed: 'solo', horizonMonths: 3, comparisons: [] });
    expect(single.run.seeds).toEqual(['solo']);
    for (const g of single.gates) {
      if (g.value !== null && g.id !== 'bad_rate_monotonic' && g.id !== 'pool_funding') {
        expect(g.min).toBe(g.value);
        expect(g.max).toBe(g.value);
      }
    }
    expect(renderMarkdown(single)).toContain('One seed');
  });

  it('lays JSON out the way the formatter does', () => {
    const value = {
      seeds: ['1', '2', '3'],
      empty: [],
      nested: { none: {}, rows: [{ a: 1 }, { a: null }] },
      long: Array.from({ length: 30 }, (_, i) => `value-${i}`),
    };
    const text = stableJson(value);
    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain('  "seeds": ["1", "2", "3"],');
    expect(text).toContain('  "empty": [],');
    expect(text).toContain('    "none": {},');
    // Too long for one line: one value per line.
    expect(text).toContain('  "long": [\n    "value-0",\n');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('pads tables so the checked in report is stable under the formatter', () => {
    expect(
      markdownTable(
        ['Name', 'Value'],
        [
          ['a', '1'],
          ['long name', '1,000'],
        ],
        ['left', 'right'],
      ),
    ).toBe(
      [
        '| Name      | Value |',
        '| --------- | ----: |',
        '| a         |     1 |',
        '| long name | 1,000 |',
      ].join('\n'),
    );
  });
});
