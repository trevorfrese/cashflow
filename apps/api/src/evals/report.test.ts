import { describe, expect, it } from 'vitest';

import { markdownTable, renderBaseline, renderJson, renderMarkdown } from './report.ts';
import { ILLUSTRATIVE_CHALLENGERS, evaluate } from './run.ts';

describe('evaluation and report', () => {
  const evaluation = evaluate({
    n: 120,
    seed: 'report',
    horizonMonths: 4,
    challengers: ILLUSTRATIVE_CHALLENGERS,
  });

  it('runs base, both stresses, the gates, and the challengers on one population', () => {
    expect(evaluation.base.overall.applicants).toBe(120);
    expect(evaluation.mild.stress).toBe('mild');
    expect(evaluation.severe.stress).toBe('severe');
    expect(evaluation.gates).toHaveLength(8);
    for (const g of evaluation.gates) expect(typeof g.pass).toBe('boolean');
    expect(evaluation.challengers.map((c) => c.name)).toEqual(['hold_payouts', 'cutoff_55']);
    // Same decisions under a different servicing policy: nobody swaps.
    expect(evaluation.challengers[0]!.swapSet.swapIn.count).toBe(0);
    expect(evaluation.challengers[0]!.swapSet.swapOut.count).toBe(0);
    // A higher cutoff can only remove approvals.
    expect(evaluation.challengers[1]!.swapSet.swapIn.count).toBe(0);
  });

  it('renders deterministic output with every section and no em dashes', () => {
    const md = renderMarkdown(evaluation);
    expect(renderMarkdown(evaluate({ n: 120, seed: 'report', horizonMonths: 4 }))).toBe(
      renderMarkdown({ ...evaluation, challengers: [] }),
    );
    for (const heading of [
      '## Headline (base case)',
      '## Gates (Balanced risk appetite)',
      '## By grade (base case)',
      '## By archetype (base case)',
      '## Stress',
      '## Capital pool by month (base case)',
      '## Challengers (illustrative, not gated)',
      '## What this can and cannot tell you',
    ]) {
      expect(md).toContain(heading);
    }
    const json = renderJson(evaluation);
    const baseline = renderBaseline(evaluation);
    expect(JSON.parse(json).scenarios.base.overall.applicants).toBe(120);
    expect(JSON.parse(baseline).gates).toHaveLength(8);
    expect(JSON.parse(baseline).headline.base.netLossBps).toBe(evaluation.base.overall.netLossBps);
    for (const text of [md, json, baseline])
      expect(text).not.toContain(String.fromCharCode(0x2014));
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
