import { formatCents } from '@cashflow/shared';

import { ASSUMPTIONS, STRESS } from './assumptions.ts';
import { GATE_THRESHOLDS, type GateResult } from './gates.ts';
import type { PortfolioMetrics, SegmentMetrics } from './metrics.ts';
import type { Evaluation } from './run.ts';

/**
 * Turns an evaluation into the Markdown report, the full JSON, and the small baseline file
 * that is checked in. Output is deterministic for a given evaluation: no timestamps, no
 * runtimes, so a rerun with unchanged code produces an empty diff.
 */

type Align = 'left' | 'right';

/** A Markdown table with padded columns, laid out the way Prettier would lay it out. */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly Align[] = [],
): string {
  const widths = headers.map((h, i) =>
    Math.max(3, h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const cell = (text: string, i: number) =>
    align[i] === 'right' ? text.padStart(widths[i]!) : text.padEnd(widths[i]!);
  const line = (cells: readonly string[]) =>
    `| ${headers.map((_, i) => cell(cells[i] ?? '', i)).join(' | ')} |`;
  const rule = `| ${widths
    .map((w, i) => (align[i] === 'right' ? `${'-'.repeat(w - 1)}:` : '-'.repeat(w)))
    .join(' | ')} |`;
  return [line(headers), rule, ...rows.map(line)].join('\n');
}

const dollars = (cents: number) => formatCents(Math.round(cents / 100) * 100, { showCents: false });
const pct = (bpsValue: number, digits = 1) => `${(bpsValue / 100).toFixed(digits)}%`;
const count = (n: number) => n.toLocaleString('en-US');

function gateValue(g: GateResult): string {
  if (g.value === null) return 'not measurable';
  if (g.unit === 'cents') return dollars(g.value);
  if (g.unit === 'AUC') return g.value.toFixed(3);
  if (g.unit.startsWith('bps of') && g.unit !== 'bps of volume') return pct(g.value);
  return `${count(g.value)}`;
}

function gateThreshold(g: GateResult): string {
  const t =
    g.unit === 'cents'
      ? dollars(g.threshold)
      : g.unit === 'AUC'
        ? g.threshold.toFixed(2)
        : g.unit.startsWith('bps of') && g.unit !== 'bps of volume'
          ? pct(g.threshold, 0)
          : String(g.threshold);
  return `${g.comparator} ${t}`;
}

function segmentRow(name: string, m: SegmentMetrics): string[] {
  return [
    name,
    count(m.applicants),
    count(m.plans),
    dollars(m.volumeCents),
    pct(m.badRateBps),
    String(m.netLossBps),
    dollars(m.netMarginCents),
    String(m.netMarginBps),
    pct(m.profitableShareBps, 0),
  ];
}

const SEGMENT_HEADERS = [
  'Segment',
  'Applicants',
  'Plans',
  'Volume',
  'Bad rate',
  'Net loss bps',
  'Net margin',
  'Margin bps',
  'Profitable',
];
const SEGMENT_ALIGN: Align[] = [
  'left',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
];

function segmentTable(
  cut: Record<string, SegmentMetrics>,
  first: string,
  skipEmpty = false,
): string {
  const rows = Object.entries(cut)
    .filter(([, m]) => !skipEmpty || m.applicants > 0)
    .map(([k, m]) => segmentRow(k, m));
  return markdownTable([first, ...SEGMENT_HEADERS.slice(1)], rows, SEGMENT_ALIGN);
}

function headlineRows(m: PortfolioMetrics): [string, string][] {
  const o = m.overall;
  return [
    ['Applicants', count(o.applicants)],
    ['Approved', `${count(o.approved)} (${pct(o.approvalRateBps)})`],
    ['Declined', `${count(o.declined)} (${pct(m.declineRateBps)})`],
    ['Needs info', `${count(o.needsInfo)} (${pct(m.needsInfoRateBps)})`],
    ['Plans funded', count(o.plans)],
    ['Plan-months', count(o.planMonths)],
    ['Rent volume advanced', dollars(o.volumeCents)],
    ['Gross fee income', `${dollars(o.feeIncomeCents)} (${bpsOf(o.feeIncomeCents, o)} bps)`],
    ['Cost of funds', `${dollars(o.costOfFundsCents)} (${bpsOf(o.costOfFundsCents, o)} bps)`],
    ['Servicing cost', `${dollars(o.servicingCostCents)} (${bpsOf(o.servicingCostCents, o)} bps)`],
    ['Charge-offs', dollars(o.chargeOffCents)],
    ['Recoveries', dollars(o.recoveryCents)],
    ['Net loss', `${dollars(o.netLossCents)} (${o.netLossBps} bps of volume)`],
    ['Net margin', `${dollars(o.netMarginCents)} (${o.netMarginBps} bps of volume)`],
    ['Bad rate (30+ days past due or written off)', pct(o.badRateBps)],
    ['First payment default rate', pct(o.firstPaymentDefaultRateBps)],
    ['Customers who were net profitable', pct(o.profitableShareBps)],
    [
      'AUC of score against bad',
      m.rankOrdering.auc === null ? 'n/a' : m.rankOrdering.auc.toFixed(3),
    ],
    ['KS of score against bad', m.rankOrdering.ks === null ? 'n/a' : m.rankOrdering.ks.toFixed(3)],
    [
      'Fraud archetype applicants approved',
      `${count(m.fraud.approved)} of ${count(m.fraud.applicants)} (${pct(m.fraud.approvalRateBps)})`,
    ],
    ['Pool at start', dollars(m.pool.startCents)],
    ['Peak monthly payouts', dollars(m.pool.peakMonthlyPayoutsCents)],
    ['Minimum pool cash', dollars(m.pool.minCents)],
    ['Peak pool utilization', pct(m.pool.peakUtilizationBps)],
    ['Payouts the pool could not fund on the due date', count(m.pool.unfundedPayouts)],
    [
      'Largest industry by volume',
      `${m.concentration.topIndustry ?? 'n/a'} (${pct(m.concentration.topShareBps)}, HHI ${count(m.concentration.hhi)})`,
    ],
  ];
}

function bpsOf(cents: number, o: SegmentMetrics): number {
  return o.volumeCents === 0 ? 0 : Math.round((cents * 10_000) / o.volumeCents);
}

function stressTable(e: Evaluation): string {
  const cols = [e.base, e.mild, e.severe];
  const row = (label: string, f: (m: PortfolioMetrics) => string) => [label, ...cols.map(f)];
  return markdownTable(
    ['Metric', 'Base', 'Mild stress', 'Severe stress'],
    [
      row('Approval rate', (m) => pct(m.overall.approvalRateBps)),
      row('Plans funded', (m) => count(m.overall.plans)),
      row('Rent volume', (m) => dollars(m.overall.volumeCents)),
      row('Bad rate', (m) => pct(m.overall.badRateBps)),
      row('First payment default rate', (m) => pct(m.overall.firstPaymentDefaultRateBps)),
      row('Net loss', (m) => dollars(m.overall.netLossCents)),
      row('Net loss, bps of volume', (m) => String(m.overall.netLossBps)),
      row('Net margin', (m) => dollars(m.overall.netMarginCents)),
      row('Net margin, bps of volume', (m) => String(m.overall.netMarginBps)),
      row('Profitable customers', (m) => pct(m.overall.profitableShareBps)),
      row('AUC', (m) => (m.rankOrdering.auc === null ? 'n/a' : m.rankOrdering.auc.toFixed(3))),
      row('Minimum pool cash', (m) => dollars(m.pool.minCents)),
      row('Unfunded payouts', (m) => count(m.pool.unfundedPayouts)),
    ],
    ['left', 'right', 'right', 'right'],
  );
}

function poolTable(m: PortfolioMetrics): string {
  return markdownTable(
    [
      'Month',
      'Active plans',
      'Payouts',
      'Collected',
      'Min pool cash',
      'End pool cash',
      'Receivable',
      'Peak use',
    ],
    m.pool.months.map((p) => [
      p.month,
      count(p.activePlans),
      dollars(p.payoutsCents),
      dollars(p.collectedCents),
      dollars(p.minPoolCents),
      dollars(p.endPoolCents),
      dollars(p.endReceivableCents),
      pct(p.peakUtilizationBps, 0),
    ]),
    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

function challengerSection(e: Evaluation): string[] {
  if (e.challengers.length === 0) return [];
  const row = (name: string, m: PortfolioMetrics) => [
    name,
    pct(m.overall.approvalRateBps),
    dollars(m.overall.volumeCents),
    pct(m.overall.badRateBps),
    String(m.overall.netLossBps),
    dollars(m.overall.netMarginCents),
    String(m.overall.netMarginBps),
    count(m.pool.unfundedPayouts),
  ];
  const lines = [
    '## Challengers (illustrative, not gated)',
    '',
    'Each challenger changes one thing and runs on the same applicants in the base case. They',
    'show that the comparison machinery works and how sensitive the result is. They are not',
    'policy proposals.',
    '',
    ...e.challengers.map((c) => `- \`${c.name}\`: ${c.description}`),
    '',
    markdownTable(
      [
        'Run',
        'Approval',
        'Volume',
        'Bad rate',
        'Net loss bps',
        'Net margin',
        'Margin bps',
        'Unfunded payouts',
      ],
      [row('champion', e.base), ...e.challengers.map((c) => row(c.name, c.metrics))],
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
    'Swap sets against the champion. Swap ins are judged on the challenger run, swap outs on the',
    'champion run.',
    '',
    markdownTable(
      [
        'Challenger',
        'Swap in',
        'Swap in bad rate',
        'Swap out',
        'Swap out bad rate',
        'Swap out net margin',
      ],
      e.challengers.map((c) => [
        c.name,
        count(c.swapSet.swapIn.count),
        c.swapSet.swapIn.plans > 0 ? pct(c.swapSet.swapIn.badRateBps) : 'n/a',
        count(c.swapSet.swapOut.count),
        c.swapSet.swapOut.plans > 0 ? pct(c.swapSet.swapOut.badRateBps) : 'n/a',
        dollars(c.swapSet.swapOut.netMarginCents),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
  ];
  return lines;
}

export function renderMarkdown(e: Evaluation): string {
  const passed = e.gates.filter((g) => g.pass).length;
  const lines = [
    '# Portfolio evaluation',
    '',
    'Generated by `pnpm --filter @cashflow/api eval:portfolio`. Do not edit by hand.',
    '',
    `Run: ${count(e.run.n)} synthetic applicants, seed \`${e.run.seed}\`, arriving over ${e.run.arrivalMonths} months at ${pct(e.run.monthlyGrowthBps, 0)} monthly growth. Each approved plan is played forward ${e.run.horizonMonths} rent periods under the \`${e.run.servicingPolicy}\` servicing policy, from a capital pool of ${dollars(e.run.poolSizeCents)}.`,
    '',
    `Gates passed: ${passed} of ${e.gates.length}.`,
    '',
    '## Headline (base case)',
    '',
    markdownTable(['Metric', 'Value'], headlineRows(e.base), ['left', 'right']),
    '',
    '## Gates (Balanced risk appetite)',
    '',
    markdownTable(
      ['Gate', 'Measured', 'Threshold', 'Result'],
      e.gates.map((g) => [g.description, gateValue(g), gateThreshold(g), g.pass ? 'PASS' : 'FAIL']),
      ['left', 'right', 'right', 'left'],
    ),
    '',
    '## By grade (base case)',
    '',
    segmentTable(e.base.byGrade, 'Grade', true),
    '',
    '## By score band (base case)',
    '',
    segmentTable(e.base.byScoreBand, 'Score', true),
    '',
    '## By archetype (base case)',
    '',
    'The fraud archetypes are the rows `bust_out`, `inflated_revenue`, and `round_trip`.',
    'Applicants counts everyone who applied. The money columns cover funded plans.',
    '',
    segmentTable(e.base.bySegment, 'Archetype'),
    '',
    '## By industry (base case)',
    '',
    segmentTable(e.base.byIndustry, 'Industry'),
    '',
    '## Stress',
    '',
    `Mild: revenue down ${Math.round(STRESS.mild.depth * 100)}% for ${STRESS.mild.days} days across the whole book, starting in month ${STRESS.mild.startMonth + 1}. Severe: down ${Math.round(STRESS.severe.depth * 100)}% for ${STRESS.severe.days} days. Later applicants are underwritten on bank history that already shows the shock.`,
    '',
    stressTable(e),
    '',
    '## Capital pool by month (base case)',
    '',
    'Min pool cash is measured right after the landlord payouts on the first, before any',
    'installment is collected. Peak use is receivables as a share of pool cash plus receivables.',
    '',
    poolTable(e.base),
    '',
    ...challengerSection(e),
    '## Assumptions',
    '',
    markdownTable(
      ['Assumption', 'Value'],
      [
        [
          'Cost of funds',
          `${pct(ASSUMPTIONS.costOfFundsAprBps, 0)} APR on principal outstanding each day`,
        ],
        [
          'Servicing cost',
          `${formatCents(ASSUMPTIONS.servicingCostCentsPerPlanMonth)} per plan-month`,
        ],
        ['Recovery on written off principal', pct(ASSUMPTIONS.recoveryRateBps, 0)],
        [
          'Loss measurement',
          `unpaid ${ASSUMPTIONS.measurementChargeOffDays} days past due at the end of observation`,
        ],
        [
          'Bad definition',
          `any installment ${ASSUMPTIONS.badDaysPastDue} days past due, or written off`,
        ],
        [
          'Monotonic gate tolerance',
          `${GATE_THRESHOLDS.monotonicToleranceBps} bps, grades under ${GATE_THRESHOLDS.monotonicMinPlans} plans skipped`,
        ],
      ],
    ),
    '',
    '## What this can and cannot tell you',
    '',
    'It can tell you whether the credit policy and the servicing rules are coherent with each',
    'other and with the unit economics: whether the score ranks risk in a population where risk',
    'is partly hidden, whether fees cover funding, servicing, and losses, how losses pile up',
    'under the servicing rules, what the pool needs at a given growth rate, and how a proposed',
    'change moves all of that on the same applicants.',
    '',
    'It cannot tell you how real businesses will perform. Every applicant here is synthetic. The',
    'hazard rates, the link between hidden health and what a bank statement shows, the fraud',
    'share, and the fraud behaviors are choices documented in `evals/README.md`, not',
    'measurements. Loss rates in this report are therefore conditional on those choices. A',
    'passing gate means the policy is internally consistent under them. It is not evidence that',
    'the policy is safe to fund with real capital, and nothing here should be read that way.',
    '',
  ];
  return lines.join('\n');
}

export function renderJson(e: Evaluation): string {
  return `${JSON.stringify(
    {
      run: e.run,
      assumptions: ASSUMPTIONS,
      stress: STRESS,
      gateThresholds: GATE_THRESHOLDS,
      gates: e.gates,
      scenarios: { base: e.base, mild: e.mild, severe: e.severe },
      challengers: e.challengers,
    },
    null,
    2,
  )}\n`;
}

/** Headline numbers and gate results: small enough to review as a diff. */
export function renderBaseline(e: Evaluation): string {
  const headline = (m: PortfolioMetrics) => ({
    approvalRateBps: m.overall.approvalRateBps,
    declineRateBps: m.declineRateBps,
    needsInfoRateBps: m.needsInfoRateBps,
    plans: m.overall.plans,
    volumeCents: m.overall.volumeCents,
    feeIncomeCents: m.overall.feeIncomeCents,
    costOfFundsCents: m.overall.costOfFundsCents,
    servicingCostCents: m.overall.servicingCostCents,
    chargeOffCents: m.overall.chargeOffCents,
    recoveryCents: m.overall.recoveryCents,
    netLossCents: m.overall.netLossCents,
    netLossBps: m.overall.netLossBps,
    netMarginCents: m.overall.netMarginCents,
    netMarginBps: m.overall.netMarginBps,
    badRateBps: m.overall.badRateBps,
    firstPaymentDefaultRateBps: m.overall.firstPaymentDefaultRateBps,
    profitableShareBps: m.overall.profitableShareBps,
    auc: m.rankOrdering.auc === null ? null : Math.round(m.rankOrdering.auc * 1000) / 1000,
    ks: m.rankOrdering.ks === null ? null : Math.round(m.rankOrdering.ks * 1000) / 1000,
    fraudApprovalRateBps: m.fraud.approvalRateBps,
    poolMinCents: m.pool.minCents,
    poolPeakUtilizationBps: m.pool.peakUtilizationBps,
    unfundedPayouts: m.pool.unfundedPayouts,
    badRateBpsByGrade: Object.fromEntries(
      Object.entries(m.byGrade)
        .filter(([, g]) => g.plans > 0)
        .map(([grade, g]) => [grade, g.badRateBps]),
    ),
  });
  return `${JSON.stringify(
    {
      run: e.run,
      headline: { base: headline(e.base), mild: headline(e.mild), severe: headline(e.severe) },
      gates: e.gates.map((g) => ({
        id: g.id,
        value: g.value,
        comparator: g.comparator,
        threshold: g.threshold,
        unit: g.unit,
        pass: g.pass,
      })),
    },
    null,
    2,
  )}\n`;
}
