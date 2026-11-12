import { catalogEntry, formatCents } from '@cashflow/shared';

import { ASSUMPTIONS, STRESS } from './assumptions.ts';
import { GATE_THRESHOLDS, type GateResult } from './gates.ts';
import {
  POLICY_OUTCOME_GROUPS,
  type PolicyOutcomeGroup,
  type PortfolioMetrics,
  type RankOrdering,
  type SegmentMetrics,
  type SwapSet,
  type ThroughTheDoorCell,
  type ThroughTheDoorMetrics,
} from './metrics.ts';
import { SIMULATED_REVIEWER_DECLINE_REASON } from './portfolio.ts';
import type { Evaluation, ThroughTheDoorOutcome } from './run.ts';

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

function gateNumber(g: GateResult, v: number | null, digits = 1): string {
  if (v === null) return 'not measurable';
  if (g.unit === 'cents') return dollars(v);
  if (g.unit === 'AUC') return v.toFixed(3);
  if (g.unit.startsWith('bps of') && g.unit !== 'bps of volume') return pct(v, digits);
  return `${count(v)}`;
}

function gateRange(g: GateResult): string {
  if (g.min === null || g.max === null) return 'n/a';
  if (g.min === g.max) return gateNumber(g, g.min);
  return `${gateNumber(g, g.min)} to ${gateNumber(g, g.max)}`;
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
    ['Approved for less than the rent requested (counter offer)', count(o.counterOffers)],
    ['Counter offers that could not be used (no plan opened)', count(o.unusableCounterOffers)],
    [
      'Approved on usable terms',
      `${count(o.approved - o.unusableCounterOffers)} (${pct(o.usableApprovalRateBps)})`,
    ],
    ['Approved by the engine alone', count(o.autoApproved)],
    ['Referred to a reviewer', `${count(o.referred)} (${pct(o.referRateBps)})`],
    ['Declined', `${count(o.declined)} (${pct(m.declineRateBps)})`],
    ['Needs info', `${count(o.needsInfo)} (${pct(m.needsInfoRateBps)})`],
    ['Plans funded', count(o.plans)],
    ['Plans whose start waited for pool capacity', count(m.funding.plansDelayed)],
    ['Approved but never funded', count(m.funding.plansNeverFunded)],
    ['Plan-months', count(o.planMonths)],
    ['Rent volume advanced', dollars(o.volumeCents)],
    ['Gross fee income', `${dollars(o.feeIncomeCents)} (${bpsOf(o.feeIncomeCents, o)} bps)`],
    ['Cost of funds', `${dollars(o.costOfFundsCents)} (${bpsOf(o.costOfFundsCents, o)} bps)`],
    ['Servicing cost', `${dollars(o.servicingCostCents)} (${bpsOf(o.servicingCostCents, o)} bps)`],
    ['Charge-offs', dollars(o.chargeOffCents)],
    ['Recoveries', dollars(o.recoveryCents)],
    ['Net loss', `${dollars(o.netLossCents)} (${o.netLossBps} bps of volume)`],
    ['Net margin', `${dollars(o.netMarginCents)} (${o.netMarginBps} bps of volume)`],
    ['Landlord payouts held', count(o.heldPayouts)],
    ['Held payouts released and paid', count(o.releasedPayouts)],
    ['Payouts cancelled (never paid)', count(o.cancelledPayouts)],
    ['Debits put off by the balance check', count(o.deferredDebits)],
    ['Debits returned for insufficient funds', count(o.failedDebits)],
    ['Bad rate (30+ days past due or written off)', pct(o.badRateBps)],
    ['First payment default rate', pct(o.firstPaymentDefaultRateBps)],
    ['Customers who were net profitable', pct(o.profitableShareBps)],
    [
      'Fraud archetype applicants approved',
      `${count(m.fraud.approved)} of ${count(m.fraud.applicants)} (${pct(m.fraud.approvalRateBps)})`,
    ],
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
      row('AUC, funded plans only', (m) =>
        m.rankOrdering.auc === null ? 'n/a' : m.rankOrdering.auc.toFixed(3),
      ),
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

/** Mean across seeds with the lowest and highest seed, formatted by `fmt`. */
function meanRange(
  runs: readonly PortfolioMetrics[],
  pick: (m: PortfolioMetrics) => number | null,
  fmt: (v: number) => string,
): string {
  return meanRangeOf(runs.map(pick), fmt);
}

function meanRangeOf(all: readonly (number | null)[], fmt: (v: number) => string): string {
  const values = all.filter((v): v is number => v !== null);
  if (values.length === 0) return 'n/a';
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return fmt(mean);
  return `${fmt(mean)} (${fmt(Math.min(...values))} to ${fmt(Math.max(...values))})`;
}

interface Column {
  name: string;
  base: readonly PortfolioMetrics[];
  mild: readonly PortfolioMetrics[] | null;
  throughTheDoor: ThroughTheDoorOutcome | null;
  gates: readonly GateResult[] | null;
}

function columns(e: Evaluation): Column[] {
  return [
    ...e.comparisons.map((c) => ({
      name: c.name,
      base: c.baseBySeed,
      mild: c.mildBySeed,
      throughTheDoor: c.throughTheDoor,
      gates: c.gates,
    })),
    {
      name: `${e.run.gated} (gated)`,
      base: e.baseBySeed,
      mild: e.mildBySeed,
      throughTheDoor: e.throughTheDoor,
      gates: e.gates,
    },
  ];
}

function comparisonTable(e: Evaluation): string {
  const cols = columns(e);
  const bpsPct = (v: number) => pct(v);
  const whole = (v: number) => String(Math.round(v));
  const row = (
    label: string,
    pick: (m: PortfolioMetrics) => number | null,
    fmt: (v: number) => string,
  ) => [label, ...cols.map((c) => meanRange(c.base, pick, fmt))];
  return markdownTable(
    ['Metric (mean, lowest to highest seed)', ...cols.map((c) => c.name)],
    [
      row('Approval rate', (m) => m.overall.approvalRateBps, bpsPct),
      row('Refer rate', (m) => m.overall.referRateBps, bpsPct),
      row('Decline rate', (m) => m.declineRateBps, bpsPct),
      row('Needs info rate', (m) => m.needsInfoRateBps, bpsPct),
      row('Rent volume', (m) => m.overall.volumeCents, dollars),
      row('Bad rate', (m) => m.overall.badRateBps, bpsPct),
      row('First payment default rate', (m) => m.overall.firstPaymentDefaultRateBps, bpsPct),
      row('Fee income, bps of volume', (m) => bpsOf(m.overall.feeIncomeCents, m.overall), whole),
      row('Net loss, bps of volume', (m) => m.overall.netLossBps, whole),
      row('Net margin, bps of volume', (m) => m.overall.netMarginBps, whole),
      row('Net margin', (m) => m.overall.netMarginCents, dollars),
      [
        'Net margin, mild stress',
        ...cols.map((c) =>
          c.mild ? meanRange(c.mild, (m) => m.overall.netMarginCents, dollars) : 'not run',
        ),
      ],
      row('Profitable customers', (m) => m.overall.profitableShareBps, bpsPct),
      [
        'AUC through the door, honest applicants (gated)',
        ...cols.map((c) =>
          c.throughTheDoor
            ? meanRangeOf(
                c.throughTheDoor.bySeed.map((t) => t.honest.auc),
                (v) => v.toFixed(3),
              )
            : 'not run',
        ),
      ],
      row(
        'AUC, funded plans only (not gated)',
        (m) => m.rankOrdering.auc,
        (v) => v.toFixed(3),
      ),
      row('Fraud applicants approved', (m) => m.fraud.approvalRateBps, bpsPct),
      row('Peak pool utilization', (m) => m.pool.peakUtilizationBps, bpsPct),
      row('Unfunded payouts', (m) => m.pool.unfundedPayouts, whole),
    ],
    ['left', ...cols.map(() => 'right' as Align)],
  );
}

function gateComparisonTable(e: Evaluation): string {
  const cols = columns(e).filter((c) => c.gates !== null);
  return markdownTable(
    ['Gate', 'Threshold', ...cols.map((c) => c.name)],
    e.gates.map((g) => [
      g.id,
      gateThreshold(g),
      ...cols.map((c) => {
        const other = c.gates!.find((x) => x.id === g.id)!;
        return `${gateNumber(other, other.value)} ${other.pass ? 'PASS' : 'FAIL'}`;
      }),
    ]),
    ['left', 'right', ...cols.map(() => 'right' as Align)],
  );
}

function beforeAfterTable(
  before: Record<string, SegmentMetrics>,
  after: Record<string, SegmentMetrics>,
  first: string,
): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const cell = (m: SegmentMetrics | undefined, f: (m: SegmentMetrics) => string) =>
    m && m.plans > 0 ? f(m) : m ? '0' : 'n/a';
  return markdownTable(
    [
      first,
      'Applicants',
      'Approved before',
      'Approved after',
      'Plans before',
      'Plans after',
      'Bad rate before',
      'Bad rate after',
      'Margin bps before',
      'Margin bps after',
    ],
    keys.map((k) => {
      const b = before[k];
      const a = after[k];
      return [
        k,
        count((a ?? b)!.applicants),
        b ? pct(b.approvalRateBps, 0) : 'n/a',
        a ? pct(a.approvalRateBps, 0) : 'n/a',
        cell(b, (m) => count(m.plans)),
        cell(a, (m) => count(m.plans)),
        cell(b, (m) => pct(m.badRateBps)),
        cell(a, (m) => pct(m.badRateBps)),
        cell(b, (m) => String(m.netMarginBps)),
        cell(a, (m) => String(m.netMarginBps)),
      ];
    }),
    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

function calibrationTable(m: PortfolioMetrics): string {
  return markdownTable(
    [
      'Score',
      'Plans',
      'Expected bad rate',
      'Realized bad rate',
      'Expected loss bps',
      'Realized loss bps',
    ],
    m.calibration.map((r) => [
      r.band,
      count(r.plans),
      pct(r.expectedBadRateBps),
      pct(r.realizedBadRateBps),
      String(r.expectedLossBps),
      String(r.realizedLossBps),
    ]),
    ['left', 'right', 'right', 'right', 'right', 'right'],
  );
}

function swapRow(name: string, s: SwapSet): string[] {
  return [
    name,
    count(s.swapIn.count),
    s.swapIn.plans > 0 ? pct(s.swapIn.badRateBps) : 'n/a',
    dollars(s.swapIn.netMarginCents),
    count(s.swapOut.count),
    s.swapOut.plans > 0 ? pct(s.swapOut.badRateBps) : 'n/a',
    dollars(s.swapOut.netMarginCents),
  ];
}

const SWAP_HEADERS = [
  'Comparison',
  'Swap in',
  'Swap in bad rate',
  'Swap in net margin',
  'Swap out',
  'Swap out bad rate',
  'Swap out net margin',
];
const SWAP_ALIGN: Align[] = ['left', 'right', 'right', 'right', 'right', 'right', 'right'];

function swapSection(e: Evaluation): string[] {
  const rows = e.comparisons
    .filter((c) => c.swapSet !== null)
    .map((c) => swapRow(`${c.name} to ${e.run.gated}`, c.swapSet!));
  if (rows.length === 0) return [];
  return [
    '## Swap sets against the earlier configurations',
    '',
    'Who the gated configuration approves that each comparison did not (swap in, judged on how',
    'they performed under the gated configuration), and who it no longer approves (swap out,',
    'judged on how they performed under the comparison). A good policy change swaps out plans',
    'that lost money and swaps in few or none.',
    '',
    markdownTable(SWAP_HEADERS, rows, SWAP_ALIGN),
    '',
  ];
}

function rollTable(m: PortfolioMetrics): string {
  const rate = (r: { observedCents: number; rollRateBps: number }) =>
    r.observedCents === 0 ? 'n/a' : pct(r.rollRateBps, 2);
  return markdownTable(
    [
      'Bucket',
      'Principal on the first of a month',
      'Later written off',
      'Roll rate',
      'Principal on entering the bucket',
      'Later written off',
      'Roll rate',
    ],
    m.bucketRoll.map((r, i) => {
      const entry = m.bucketEntryRoll[i]!;
      return [
        r.bucket,
        dollars(r.observedCents),
        dollars(r.chargedOffCents),
        rate(r),
        dollars(entry.observedCents),
        dollars(entry.chargedOffCents),
        rate(entry),
      ];
    }),
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

function sensitivitySection(e: Evaluation): string[] {
  if (e.sensitivities.length === 0) return [];
  const row = (name: string, m: PortfolioMetrics, bySeed: readonly PortfolioMetrics[]) => [
    name,
    pct(m.overall.approvalRateBps),
    pct(m.overall.usableApprovalRateBps),
    count(m.overall.plans),
    dollars(m.overall.volumeCents),
    pct(m.overall.badRateBps),
    `${dollars(m.overall.netLossCents)} (${m.overall.netLossBps})`,
    `${dollars(m.overall.netMarginCents)} (${m.overall.netMarginBps})`,
    meanRange(
      bySeed,
      (x) => x.rankOrdering.auc,
      (v) => v.toFixed(3),
    ),
  ];
  return [
    '## Sensitivities (not gated)',
    '',
    'The gated configuration with one assumption of the simulation changed, on the same',
    'applicants in the base case, seeds pooled. These numbers do not decide a gate.',
    '',
    ...e.sensitivities.map((c) => `- \`${c.name}\`: ${c.description}`),
    '',
    markdownTable(
      [
        'Run',
        'Approved',
        'Approved on usable terms',
        'Plans',
        'Volume',
        'Bad rate',
        'Net loss (bps)',
        'Net margin (bps)',
        'Funded only AUC (mean, range)',
      ],
      [
        row(`${e.run.gated} (gated)`, e.base, e.baseBySeed),
        ...e.sensitivities.map((c) => row(c.name, c.metrics, c.metricsBySeed)),
      ],
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
  ];
}

function challengerSection(e: Evaluation): string[] {
  if (e.challengers.length === 0) return [];
  const row = (name: string, m: PortfolioMetrics, bySeed: readonly PortfolioMetrics[]) => [
    name,
    pct(m.overall.approvalRateBps),
    pct(m.overall.referRateBps),
    dollars(m.overall.volumeCents),
    pct(m.overall.badRateBps),
    String(m.overall.netLossBps),
    String(m.overall.netMarginBps),
    meanRange(
      bySeed,
      (x) => x.rankOrdering.auc,
      (v) => v.toFixed(3),
    ),
    pct(m.fraud.approvalRateBps),
  ];
  return [
    '## Challengers (not gated)',
    '',
    'Each challenger changes one thing about the gated configuration and runs on the same',
    'applicants in the base case. Swap ins are judged on the challenger run, swap outs on the',
    'gated run.',
    '',
    ...e.challengers.map((c) => `- \`${c.name}\`: ${c.description}`),
    '',
    markdownTable(
      [
        'Run',
        'Approval',
        'Refer',
        'Volume',
        'Bad rate',
        'Net loss bps',
        'Margin bps',
        'Funded only AUC (mean, range)',
        'Fraud approved',
      ],
      [
        row(`${e.run.gated} (gated)`, e.base, e.baseBySeed),
        ...e.challengers.map((c) => row(c.name, c.metrics, c.metricsBySeed)),
      ],
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
    markdownTable(
      SWAP_HEADERS,
      e.challengers.map((c) => swapRow(`${e.run.gated} to ${c.name}`, c.swapSet)),
      SWAP_ALIGN,
    ),
    '',
  ];
}

const fixed3 = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
const mean = (values: readonly (number | null)[]): number | null => {
  const measured = values.filter((v): v is number => v !== null);
  return measured.length === values.length && measured.length > 0
    ? measured.reduce((a, b) => a + b, 0) / measured.length
    : null;
};

const POLICY_OUTCOME_LABELS: Record<PolicyOutcomeGroup, string> = {
  approvedUsable: 'Approved on usable terms',
  approvedCounterOffer: 'Approved for less than the rent (no plan in the product)',
  declined: 'Declined',
};

function rankOrderingTable(e: Evaluation): string {
  const row = (
    name: string,
    honest: RankOrdering,
    all: RankOrdering,
    funded: RankOrdering,
  ): string[] => [
    name,
    fixed3(honest.auc),
    fixed3(honest.ks),
    `${count(honest.goods)} / ${count(honest.bads)}`,
    fixed3(all.auc),
    fixed3(all.ks),
    `${count(all.goods)} / ${count(all.bads)}`,
    fixed3(funded.auc),
    fixed3(funded.ks),
    `${count(funded.goods)} / ${count(funded.bads)}`,
  ];
  const door = e.throughTheDoor;
  const rows = e.run.seeds.map((seed, i) =>
    row(`Seed ${seed}`, door.bySeed[i]!.honest, door.bySeed[i]!.all, e.baseBySeed[i]!.rankOrdering),
  );
  if (e.run.seeds.length > 1) {
    const funded = e.baseBySeed.map((m) => m.rankOrdering);
    rows.push([
      'Mean of seeds',
      fixed3(mean(door.bySeed.map((t) => t.honest.auc))),
      fixed3(mean(door.bySeed.map((t) => t.honest.ks))),
      '',
      fixed3(mean(door.bySeed.map((t) => t.all.auc))),
      fixed3(mean(door.bySeed.map((t) => t.all.ks))),
      '',
      fixed3(mean(funded.map((r) => r.auc))),
      fixed3(mean(funded.map((r) => r.ks))),
      '',
    ]);
    rows.push(row('Seeds pooled', door.pooled.honest, door.pooled.all, e.base.rankOrdering));
  }
  return markdownTable(
    [
      'Seeds',
      'Honest AUC (gated)',
      'Honest KS',
      'Honest good / bad',
      'All AUC',
      'All KS',
      'All good / bad',
      'Funded only AUC',
      'Funded only KS',
      'Funded good / bad',
    ],
    rows,
    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

function throughTheDoorCellTable(
  cells: Record<string, ThroughTheDoorCell>,
  first: string,
  label: (key: string) => string = (key) => key,
): string {
  return markdownTable(
    [
      first,
      'Scored applicants',
      'Approved on usable terms',
      'Bad',
      'Bad rate',
      'Honest applicants',
      'Honest bad',
      'Honest bad rate',
    ],
    Object.entries(cells)
      .filter(([, c]) => c.plans > 0)
      .map(([key, c]) => [
        label(key),
        count(c.plans),
        `${count(c.approvedUsable)} (${pct(c.plans === 0 ? 0 : Math.round((c.approvedUsable * 10_000) / c.plans), 0)})`,
        count(c.bad),
        pct(c.badRateBps),
        count(c.honestPlans),
        count(c.honestBad),
        c.honestPlans > 0 ? pct(c.honestBadRateBps) : 'n/a',
      ]),
    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
}

function throughTheDoorSection(e: Evaluation): string[] {
  const t: ThroughTheDoorMetrics = e.throughTheDoor.pooled;
  return [
    '## Rank ordering through the door (base case)',
    '',
    'The AUC gate asks whether the score ranks risk. It is judged on every applicant the engine',
    'scored, not only on the plans the policy funded. To get a bad flag for an applicant the',
    'policy declined, the same applicants are run a second time with every scored applicant',
    `funded: ${count(t.scored)} of ${count(t.applicants)} here (the other ${count(t.unscored)} were asked for more information and have no`,
    'score). Each gets a plan at the rent requested, since the product fronts a whole lease or',
    `nothing, under the \`${e.run.servicingPolicy}\` servicing policy, from a pool with no limit and with no`,
    'exposure or concentration rule, and is flagged bad by the same definition as everywhere',
    'else in this report. Approved and referred applicants pay the fee they were quoted. A',
    'declined applicant pays the fee the pricing built up for them, held to the fee cap, or',
    'the grade D floor if they were knocked out before pricing. This second run is separate',
    'from the gated run: it shares its applicants and nothing else, and no other number in',
    'this report reads it.',
    '',
    'The gate is judged on honest applicants only. The score is there to rank credit risk.',
    'Stopping the fraud archetypes is the job of the integrity checks, which the fraud gate',
    'judges, and a fraud applicant who goes bad says nothing about how well the score reads a',
    'real business. The figure for all applicants is beside it.',
    '',
    'The funded only AUC is what the gate judged before, and it is still reported here, ungated.',
    'It is range restricted: the policy has already declined the applicants the score ranks',
    'lowest, so the funded plans sit in a narrow band of high scores with a few dozen bad plans',
    'per seed among them. A score cannot show ranking power on a population it has already',
    'filtered, and the figure moves several points from seed to seed.',
    '',
    rankOrderingTable(e),
    '',
    'Counterfactual bad rate by score band, seeds pooled. "Approved on usable terms" is how',
    'many of the band the policy itself funds, so the rows where it falls to zero are the',
    'bands the cutoff and the knockouts keep out.',
    '',
    throughTheDoorCellTable(t.byScoreBand, 'Score'),
    '',
    'By grade:',
    '',
    throughTheDoorCellTable(t.byGrade, 'Grade'),
    '',
    'By what the policy decided, which is what the policy is keeping out:',
    '',
    throughTheDoorCellTable(
      Object.fromEntries(POLICY_OUTCOME_GROUPS.map((g) => [g, t.byPolicyOutcome[g]])),
      'Policy decision',
      (key) => POLICY_OUTCOME_LABELS[key as PolicyOutcomeGroup],
    ),
    '',
    'A counterfactual like this is only possible because the borrowers are simulated. A lender',
    'with real applicants never sees how a declined one would have performed, and has to',
    'estimate it by reject inference or buy it with a test and learn sample.',
    '',
  ];
}

const VERACITY_TAG_LABELS: Record<string, string> = {
  personal_account: 'Sole proprietor on a personal account',
  owner_nickname: 'Bank holder name is a nickname of the owner',
  unlisted_holder: 'Bank holder is a spouse or an unlisted holding company',
  legacy_bank: 'Legacy (non OAuth) bank connection',
  unshared_savings: 'A savings account on the login was not shared',
  savings_transfers: 'Profit moved to an unconnected savings account',
  new_bank_account: 'Recently opened bank account at an established business',
  late_posting: 'Recent items posted late between pulls',
  resync_minor: 'Aggregator re-sync changed one or two old items',
  resync_duplicates: 'Aggregator re-sync duplicated old items',
  bank_pull_fails: 'Bank pull failed at decision time',
  pos_trading_name: 'Platform account in the trading name',
  pos_owner_name: "Platform account in the owner's own name",
  pos_other_name: 'Platform account in a former or parent company name',
  pos_tax_typo: 'Platform tax id differs by a typo',
  second_payout_connected: 'Sales paid to a second account, connected',
  second_payout_unconnected: 'Sales paid to a second account, not connected',
  multi_location: 'Two locations paid separately',
  processor_holds: 'Processor holds delay some payouts',
  split_deposits: 'Bank splits some deposits',
  payout_rounding: 'Small differences between payout and deposit',
  platform_switch: 'Switched platforms mid history',
  pos_token_expired: 'Platform token expired, refresh refused',
  seat_pull_fails: 'Delegated seat report pull failed',
};

function veracitySection(e: Evaluation): string[] {
  const v = e.base.veracity;
  const h = v.honest;
  const seeds = e.baseBySeed.map((m) => m.veracity.honest);
  const meanRange2 = (vals: number[]) =>
    `${pct(vals.reduce((a, b) => a + b, 0) / vals.length, 2)} (${pct(Math.min(...vals), 2)} to ${pct(Math.max(...vals), 2)})`;
  const fraudRows = Object.entries(v.fraud).map(([type, f]) => {
    const top = Object.entries(f.byCode)
      .filter(
        ([code]) =>
          ![
            'UNSHARED_ACCOUNTS',
            'LEGACY_BANK_CONNECTION',
            'DELEGATED_SEAT_SOURCE',
            'PERSONAL_ACCOUNT',
            'PLATFORM_ACCOUNT_RECENT',
          ].includes(code),
      )
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code} ${pct((n * 10_000) / Math.max(1, f.applicants), 0)}`)
      .join(', ');
    return [
      type,
      count(f.applicants),
      pct((f.caught * 10_000) / Math.max(1, f.applicants), 0),
      `${f.byEffect.knockout} / ${f.byEffect.refer} / ${f.byEffect.needsInfo}`,
      pct((f.approved * 10_000) / Math.max(1, f.applicants), 1),
      top || 'none',
    ];
  });
  const codeRows = Object.entries(h.byCode)
    .sort((a, b) => b[1].fired - a[1].fired)
    .map(([code, c]) => [
      code,
      count(c.fired),
      pct((c.fired * 10_000) / Math.max(1, h.applicants), 2),
      count(c.adverse),
      count(c.needsInfo),
    ]);
  const tagRows = Object.entries(h.byTag).map(([tag, t]) => [
    VERACITY_TAG_LABELS[tag] ?? tag,
    count(t.applicants),
    `${t.knockout} / ${t.refer} / ${t.needsInfo}`,
    pct(t.anyRateBps, 1),
  ]);
  const cf = e.veracityCounterfactual.pooled;
  const v2 = e.comparisons.find((c) => c.name === 'v2_standard');
  const effectRows = v2
    ? [
        [
          'Usable approval rate',
          pct(v2.base.overall.usableApprovalRateBps),
          pct(e.base.overall.usableApprovalRateBps),
        ],
        ['Refer rate', pct(v2.base.overall.referRateBps), pct(e.base.overall.referRateBps)],
        ['Needs info rate', pct(v2.base.needsInfoRateBps), pct(e.base.needsInfoRateBps)],
        [
          'Fraud applicants approved',
          pct(v2.base.fraud.approvalRateBps),
          pct(e.base.fraud.approvalRateBps),
        ],
        [
          'Net loss, bps of volume',
          String(v2.base.overall.netLossBps),
          String(e.base.overall.netLossBps),
        ],
        [
          'Net margin, bps of volume',
          String(v2.base.overall.netMarginBps),
          String(e.base.overall.netMarginBps),
        ],
        [
          'Net margin',
          dollars(v2.base.overall.netMarginCents),
          dollars(e.base.overall.netMarginCents),
        ],
        ['Bad rate, funded plans', pct(v2.base.overall.badRateBps), pct(e.base.overall.badRateBps)],
      ]
    : [];
  return [
    '## Data veracity (base case)',
    '',
    'What the veracity checks (`src/veracity/`) caught and what they cost, on the same applicants.',
    'The connections each applicant has, the honest messiness they show, and the five fraud',
    'archetypes are drawn in `src/evals/veracity-sim.ts`; every rate there is a choice. An',
    'applicant is "affected" when a veracity finding knocked it out, referred it, or asked it',
    'for information; the knockouts and referrals are what the `veracity_honest_adverse` gate',
    'counts.',
    '',
    '### Detection by fraud archetype',
    '',
    'Seeds pooled. Caught is the share on which a veracity finding changed the outcome. The',
    'last column is the share of the archetype on which each substantive finding fired.',
    '',
    markdownTable(
      [
        'Archetype',
        'Applicants',
        'Caught',
        'Knockout / refer / info',
        'Approved after review',
        'Findings that fired',
      ],
      fraudRows,
      ['left', 'right', 'right', 'right', 'right', 'left'],
    ),
    '',
    '### Honest applicants: false positives',
    '',
    `Knocked out or referred (the gate): ${pct(h.adverseRateBps, 2)} of ${count(h.applicants)} honest applicants, mean of seeds ${meanRange2(seeds.map((s) => s.adverseRateBps))}. Asked for information: ${pct(h.needsInfoRateBps, 2)}, mean of seeds ${meanRange2(seeds.map((s) => s.needsInfoRateBps))}. Any of the three: ${pct(h.anyRateBps, 2)}. Knockouts ${h.knockout}, referrals ${h.refer}, requests for information ${h.needsInfo}. Of the knocked out and the asked, ${h.lostUsable} would have had a usable approval on the same data without the checks (a referred honest applicant is approved by the reviewer here, so a referral costs time, not the approval).`,
    '',
    'By finding: honest applicants on whom it fired, and on how many the outcome was adverse',
    'or a request for information (a finding that fires beside another one is counted for each).',
    '',
    markdownTable(
      ['Finding', 'Fired', 'Share of honest', 'Knocked out or referred', 'Asked for information'],
      codeRows,
      ['left', 'right', 'right', 'right', 'right'],
    ),
    '',
    'By the honest messiness simulated:',
    '',
    markdownTable(
      ['Honest situation', 'Applicants', 'Knockout / refer / info', 'Affected'],
      tagRows,
      ['left', 'right', 'right', 'right'],
    ),
    '',
    '### Were the affected honest applicants riskier?',
    '',
    'Each affected honest applicant funded at the rent requested in a counterfactual run that',
    'decides without the veracity facts, against honest applicants the checks left alone, from',
    'the through the door run.',
    '',
    markdownTable(
      ['Group', 'Plans', 'Bad', 'Bad rate'],
      [
        [
          'Affected honest applicants',
          count(cf.affected.plans),
          count(cf.affected.bad),
          pct(cf.affected.badRateBps),
        ],
        [
          'Unaffected honest applicants, all scored',
          count(cf.unaffected.plans),
          count(cf.unaffected.bad),
          pct(cf.unaffected.badRateBps),
        ],
        [
          'Unaffected honest applicants approved on usable terms',
          count(cf.unaffectedApprovedUsable.plans),
          count(cf.unaffectedApprovedUsable.bad),
          pct(cf.unaffectedApprovedUsable.badRateBps),
        ],
      ],
      ['left', 'right', 'right', 'right'],
    ),
    '',
    ...(v2
      ? [
          '### Net effect against the policy without the checks',
          '',
          `\`v2_standard\` against \`${e.run.gated}\`, the same applicants, seeds pooled.`,
          '',
          markdownTable(['Metric', 'v2_standard', e.run.gated], effectRows, [
            'left',
            'right',
            'right',
          ]),
          '',
        ]
      : []),
  ];
}

const share = (part: number, whole: number) =>
  pct(whole === 0 ? 0 : Math.round((part * 10_000) / whole));

/** Pass-through plans and the cohort that graduated from them, base and stress. */
function passThroughSection(e: Evaluation): string[] {
  const scenarios = [
    ['Base', e.base],
    ['Mild stress', e.mild],
    ['Severe stress', e.severe],
  ] as const;
  if (!e.base.passThrough) return [];
  const statRows = scenarios.map(([name, m]) => {
    const s = m.passThrough!.stats;
    return [
      name,
      count(s.declined),
      count(s.eligible),
      count(s.plans),
      count(s.months),
      share(s.onTimeMonths, s.months),
      share(s.missedMonths, s.months),
      dollars(s.volumeCents),
      count(s.reviews),
      count(s.reviewReferred),
      count(s.offers),
      count(s.graduated),
    ];
  });
  const cohortRows = scenarios.map(([name, m]) => {
    const g = m.passThrough!.graduated;
    return [
      name,
      count(g.plans),
      count(g.planMonths),
      dollars(g.volumeCents),
      pct(g.badRateBps),
      `${g.netLossBps} bps`,
      dollars(g.netMarginCents),
      `${g.netMarginBps} bps`,
      pct(g.profitableShareBps),
    ];
  });
  const bookRows = scenarios.map(([name, m]) => {
    const o = m.overall;
    const b = m.passThrough!.bookWithGraduates;
    return [
      name,
      `${o.netLossBps} bps`,
      `${b.netLossBps} bps`,
      `${o.netMarginBps} bps`,
      `${b.netMarginBps} bps`,
      pct(o.badRateBps),
      pct(b.badRateBps),
    ];
  });
  const grades = e.base.passThrough.graduatedByGrade;
  const s = e.base.passThrough.stats;
  return [
    '## Pass-through plans and graduation',
    '',
    `Every applicant the gated policy declines for credit capacity alone is put on the free`,
    'pass-through plan: the rent is debited five business days before the due date after a',
    'balance check, and the landlord is paid on the due date only from what was collected. A',
    'month with nothing collected in time is missed and the business pays its landlord itself.',
    'The day a month completes, a plan with three on time months in a row is re-underwritten',
    'on its bank history and payment history, at most once a month. An approval for at least',
    'the rent is an offer; every offer is assumed accepted, and the graduate gets a financed',
    'plan from the next rent date, from the same pool, played like any other plan.',
    '',
    'Graduates are not in the headline numbers or the gates above, which judge the origination',
    'decisions, but they share the pool, so the pool gate and the pool path include them. The',
    'last table puts the two books together.',
    '',
    markdownTable(
      [
        'Scenario',
        'Declined',
        'Offered pass-through',
        'Plans',
        'Months',
        'On time',
        'Missed',
        'Rent passed through',
        'Reviews',
        'Would refer',
        'Offers',
        'Graduated',
      ],
      statRows,
      ['left', ...Array<Align>(11).fill('right')],
    ),
    '',
    `"Would refer" is a review whose engine outcome was a referral. It is not offered and not sent to the review queue, so pass-through and the payment history factor add no referrals: the refer rate gate reads origination decisions, which are the same as \`v3_standard\`'s for every applicant (the factor is neutral without history). Graduated fraud applicants: ${count(s.graduatedFraud)} in the base case.`,
    '',
    '### The graduated cohort',
    '',
    markdownTable(
      [
        'Scenario',
        'Plans',
        'Plan months',
        'Volume',
        'Bad rate',
        'Net loss',
        'Net margin',
        'Margin',
        'Profitable',
      ],
      cohortRows,
      ['left', ...Array<Align>(8).fill('right')],
    ),
    '',
    'By grade at graduation (base case):',
    '',
    segmentTable(grades, 'Grade', true),
    '',
    '### The book with graduates',
    '',
    markdownTable(
      [
        'Scenario',
        'Net loss, origination',
        'Net loss, with graduates',
        'Margin, origination',
        'Margin, with graduates',
        'Bad rate, origination',
        'Bad rate, with graduates',
      ],
      bookRows,
      ['left', ...Array<Align>(6).fill('right')],
    ),
    '',
  ];
}

function reasonRows(
  tally: Record<string, number>,
  first: Record<string, number> | null,
  of: number,
): string[][] {
  return Object.entries(tally)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([code, n]) => [
      `\`${code}\``,
      catalogEntry(code)?.title ?? 'Not in the catalog',
      count(n),
      share(n, of),
      ...(first ? [count(first[code] ?? 0)] : []),
    ]);
}

function adverseActionSection(e: Evaluation): string[] {
  const a = e.base.adverseAction;
  const bySeed = e.baseBySeed.map((m) => pct(m.adverseAction.withReasonBps)).join(', ');
  return [
    '## Principal reasons on declines and counter offers (base case)',
    '',
    'Every decline (by the engine, or by the simulated reviewer on a referral) and every counter',
    'offer is an adverse action, and the applicant is told its principal reasons: at most four,',
    'from the reason catalog in `packages/shared`, rules that declined first and then the',
    'scorecard factors that lost the most points. The overall score is never a reason on its own.',
    `The simulated reviewer declines with \`${SIMULATED_REVIEWER_DECLINE_REASON}\`. Explaining`,
    'decisions does not change them: the outcomes here are the same as without the catalog.',
    '',
    markdownTable(
      ['Measure', 'Value'],
      [
        ['Declines', count(a.declines)],
        ['Counter offers', count(a.counterOffers)],
        [
          'With at least one catalog reason with applicant text',
          share(a.withReason, a.adverseActions),
        ],
        ['By seed', bySeed],
        ['Principal reasons per adverse action, mean', (a.meanReasonsX100 / 100).toFixed(2)],
      ],
      ['left', 'right'],
    ),
    '',
    '### Declines: how often each reason is given',
    '',
    'A decline usually lists several reasons, so the shares add to more than 100%. "First" counts',
    'the declines that give it as the most important reason.',
    '',
    markdownTable(
      ['Code', 'Title', 'Declines', 'Share of declines', 'First'],
      reasonRows(a.declineReasons, a.declineFirstReasons, a.declines),
      ['left', 'left', 'right', 'right', 'right'],
    ),
    '',
    '### Counter offers',
    '',
    markdownTable(
      ['Code', 'Title', 'Counter offers', 'Share of counter offers'],
      reasonRows(a.counterOfferReasons, null, a.counterOffers),
      ['left', 'left', 'right', 'right'],
    ),
    '',
  ];
}

export function renderMarkdown(e: Evaluation): string {
  const passed = e.gates.filter((g) => g.pass).length;
  const v1 = e.comparisons.find((c) => c.name === 'v1_baseline');
  const seedList = e.run.seeds.map((s) => `\`${s}\``).join(', ');
  const many = e.run.seeds.length > 1;
  const lines = [
    '# Portfolio evaluation',
    '',
    'Generated by `pnpm --filter @cashflow/api eval:portfolio`. Do not edit by hand.',
    '',
    `Run: ${count(e.run.n)} synthetic applicants per seed, ${many ? `seeds ${seedList}` : `seed ${seedList}`}, arriving over ${e.run.arrivalMonths} months at ${pct(e.run.monthlyGrowthBps, 0)} monthly growth. Each approved plan is played forward ${e.run.horizonMonths} rent periods from a capital pool of ${dollars(e.run.poolSizeCents)} per seed.`,
    '',
    `Gated configuration: credit policy \`${e.run.policyVersion}\` under the \`${e.run.servicingPolicy}\` servicing policy. ${many ? `The gates are judged on the mean of the ${e.run.seeds.length} seeds; tables of counts pool the seeds into one book.` : 'One seed: the gates are judged on that seed alone.'}`,
    '',
    `Gates passed: ${passed} of ${e.gates.length}.`,
    '',
    '## Gates (Balanced risk appetite)',
    '',
    markdownTable(
      ['Gate', 'Mean', 'Lowest to highest seed', 'Threshold', 'Result'],
      e.gates.map((g) => [
        g.description,
        gateNumber(g, g.value),
        gateRange(g),
        gateThreshold(g),
        g.pass ? 'PASS' : 'FAIL',
      ]),
      ['left', 'right', 'right', 'right', 'left'],
    ),
    '',
    'Grade inversions are counted on bad rates pooled across seeds, and unfunded payouts are',
    'summed across seeds. Every other gate is the mean of the per seed values.',
    '',
    '## What underwriting bought and what servicing bought',
    '',
    'The same applicants under six configurations. Reading left to right along the top:',
    'changing only servicing (`v1_baseline` to `v1_standard`), changing only the credit policy',
    '(`v1_baseline` to `v2_baseline`), both (`v2_standard`), the data veracity checks on top',
    '(`v3_standard`), and payment history with pass-through plans and graduation on top of',
    `that (\`${e.run.gated}\`, the gated configuration). Its origination decisions are`,
    "version 3's for every applicant; it differs in the pool its graduates share.",
    '',
    ...e.comparisons.map((c) => `- \`${c.name}\`: ${c.description}`),
    '',
    comparisonTable(e),
    '',
    'The gates, applied to each configuration that was also run under mild stress. Only the',
    'last column decides whether the policy ships.',
    '',
    gateComparisonTable(e),
    '',
    ...swapSection(e),
    '## Headline (gated configuration, base case, seeds pooled)',
    '',
    markdownTable(['Metric', 'Value'], headlineRows(e.base), ['left', 'right']),
    '',
    '## By grade (base case)',
    '',
    segmentTable(e.base.byGrade, 'Grade', true),
    '',
    '## By score band (base case)',
    '',
    segmentTable(e.base.byScoreBand, 'Score', true),
    '',
    ...throughTheDoorSection(e),
    ...passThroughSection(e),
    ...veracitySection(e),
    ...adverseActionSection(e),
    '## Calibration: expected against realized (base case)',
    '',
    'Expected bad rate is the PD the fee was priced on, from the table calibrated on separate',
    'seeds. Expected loss is the per period expected loss in the fee build up. Realized figures',
    'are what happened in this run. A realized loss well above expected in a band means the',
    'fee floor, not the loss estimate, is what is keeping that band profitable.',
    '',
    e.base.calibration.length > 0 ? calibrationTable(e.base) : 'Not priced on expected loss.',
    '',
    '## By archetype (base case)',
    '',
    'The fraud archetypes are the rows `bust_out`, `inflated_revenue`, `round_trip`, and the five',
    'the data veracity checks exist for: `unsettled_sales`, `borrowed_account`,',
    '`fresh_pos_account`, `hidden_accounts`, and `rewritten_history`.',
    'Applicants counts everyone who applied. The money columns cover funded plans.',
    '',
    segmentTable(e.base.bySegment, 'Archetype'),
    '',
    ...(v1
      ? [
          '## By archetype, before and after',
          '',
          'Before is `v1_baseline`. After is the gated configuration. The `seasonal` row is the',
          'check that earlier decline detection does not punish a normal seasonal trough.',
          '',
          beforeAfterTable(v1.base.bySegment, e.base.bySegment, 'Archetype'),
          '',
        ]
      : []),
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
    `## Capital pool by month (base case, seed \`${e.run.seeds[0]}\`)`,
    '',
    'Min pool cash is measured right after the landlord payouts on the first, before any',
    'installment is collected. Peak use is receivables as a share of pool cash plus receivables.',
    '',
    poolTable(e.baseBySeed[0]!),
    '',
    '## Roll to charge-off by bucket (base case)',
    '',
    'Two measures of the same thing. On the evening of the first of each month, when the',
    'provision job sets the allowance, every unpaid installment is recorded under the',
    'delinquency bucket of its plan. And every unpaid installment is recorded once when its',
    'plan first moves into a bucket. The roll rate is the share of that principal that was',
    'later written off. All rent here is due on the first, so no plan is in the grace bucket on',
    'a provision date: only the entry measure sees it. The reserve rates in',
    '`src/servicing/policy.ts` are the first of the month rates for CURRENT, DELINQUENT, and',
    'DEFAULT and the entry rate for GRACE, rounded up.',
    '',
    rollTable(e.base),
    '',
    ...sensitivitySection(e),
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
          'Returned debits',
          `a debit the account cannot cover is booked as collected and reversed ${ASSUMPTIONS.returnDelayDays} days later (standard servicing only)`,
        ],
        [
          'Counter offers',
          'the product fronts a whole lease rent or nothing, so an approval below the rent requested opens no plan',
        ],
        ['Manual payment after failed collection', 'none (see the sensitivity)'],
        [
          'Manual review',
          `catches and declines ${pct(e.run.reviewFraudCatchRateBps, 0)} of referred fraud applicants; approves every other referral at the engine's terms`,
        ],
        [
          'Funding wait',
          `a plan the pool cannot take waits up to ${ASSUMPTIONS.maxFundingWaitMonths} rent dates`,
        ],
        [
          'Loss measurement',
          `unpaid ${ASSUMPTIONS.measurementChargeOffDays} days past due at the end of observation`,
        ],
        [
          'Bad definition',
          `any installment ${ASSUMPTIONS.badDaysPastDue} days past due, or written off`,
        ],
        [
          'AUC gate population',
          'every scored honest applicant, funded in a counterfactual run at the rent requested with no pool or exposure limit',
        ],
        [
          'Veracity gate',
          `honest applicants knocked out or referred by a veracity finding, at most ${pct(GATE_THRESHOLDS.maxVeracityAdverseHonestBps, 0)}`,
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
    'measurements. Loss rates in this report are therefore conditional on those choices. The',
    'fraud behaviors are eight scripts, and a check written after reading a script will catch',
    'it: the fraud numbers show that the checks work as designed, not how much real fraud they',
    'would stop. The honest messiness behind the false positive rates is a set of choices too.',
    'A passing gate means the policy is internally consistent under these assumptions. It is not evidence that the policy is safe to fund with real capital,',
    'and nothing here should be read that way.',
    '',
  ];
  return lines.join('\n');
}

/**
 * JSON laid out the way the formatter lays it out, so the checked in files pass the format
 * check as written: two space indent, objects one key per line, and an array of plain
 * values on one line when it fits inside the print width.
 */
export function stableJson(value: unknown, printWidth = 100): string {
  const render = (v: unknown, indent: string, keyWidth: number): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (v.every((x) => x === null || typeof x !== 'object')) {
        const oneLine = `[${v.map((x) => JSON.stringify(x) ?? 'null').join(', ')}]`;
        // Room is needed for the key before it and the comma after it.
        if (indent.length + keyWidth + oneLine.length + 1 <= printWidth) return oneLine;
      }
      return `[\n${v.map((x) => `${inner}${render(x, inner, 0)}`).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([k, x]) => {
        const key = `${JSON.stringify(k)}: `;
        return `${inner}${key}${render(x, inner, key.length)}`;
      })
      .join(',\n')}\n${indent}}`;
  };
  return `${render(value, '', 0)}\n`;
}

function headline(m: PortfolioMetrics) {
  return {
    approvalRateBps: m.overall.approvalRateBps,
    usableApprovalRateBps: m.overall.usableApprovalRateBps,
    counterOffers: m.overall.counterOffers,
    unusableCounterOffers: m.overall.unusableCounterOffers,
    referRateBps: m.overall.referRateBps,
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
    heldPayouts: m.overall.heldPayouts,
    releasedPayouts: m.overall.releasedPayouts,
    cancelledPayouts: m.overall.cancelledPayouts,
    rollRateBpsByBucket: Object.fromEntries(m.bucketRoll.map((r) => [r.bucket, r.rollRateBps])),
    entryRollRateBpsByBucket: Object.fromEntries(
      m.bucketEntryRoll.map((r) => [r.bucket, r.rollRateBps]),
    ),
    badRateBpsByGrade: Object.fromEntries(
      Object.entries(m.byGrade)
        .filter(([, g]) => g.plans > 0)
        .map(([grade, g]) => [grade, g.badRateBps]),
    ),
  };
}

const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
const rankSummary = (r: RankOrdering) => ({
  auc: round3(r.auc),
  ks: round3(r.ks),
  goods: r.goods,
  bads: r.bads,
});

/** Through the door rank ordering, per seed and pooled, with the pooled bad rates. */
function throughTheDoorSummary(t: ThroughTheDoorOutcome, seeds: readonly string[]) {
  const rates = (cells: Record<string, ThroughTheDoorCell>, honest: boolean) =>
    Object.fromEntries(
      Object.entries(cells)
        .filter(([, c]) => (honest ? c.honestPlans : c.plans) > 0)
        .map(([k, c]) => [k, honest ? c.honestBadRateBps : c.badRateBps]),
    );
  return {
    scored: t.pooled.scored,
    honest: rankSummary(t.pooled.honest),
    all: rankSummary(t.pooled.all),
    bySeed: seeds.map((seed, i) => ({
      seed,
      honest: rankSummary(t.bySeed[i]!.honest),
      all: rankSummary(t.bySeed[i]!.all),
    })),
    honestBadRateBpsByScoreBand: rates(t.pooled.byScoreBand, true),
    honestBadRateBpsByGrade: rates(t.pooled.byGrade, true),
    honestBadRateBpsByPolicyOutcome: rates(t.pooled.byPolicyOutcome, true),
    badRateBpsByPolicyOutcome: rates(t.pooled.byPolicyOutcome, false),
  };
}

const gateSummary = (gates: readonly GateResult[]) =>
  gates.map((g) => ({
    id: g.id,
    value: g.value,
    min: g.min,
    max: g.max,
    comparator: g.comparator,
    threshold: g.threshold,
    unit: g.unit,
    pass: g.pass,
  }));

export function renderJson(e: Evaluation): string {
  return stableJson({
    run: e.run,
    assumptions: ASSUMPTIONS,
    stress: STRESS,
    gateThresholds: GATE_THRESHOLDS,
    gates: e.gates,
    scenarios: { base: e.base, mild: e.mild, severe: e.severe },
    throughTheDoor: e.throughTheDoor,
    veracityCounterfactual: e.veracityCounterfactual,
    bySeed: e.run.seeds.map((seed, i) => ({
      seed,
      base: headline(e.baseBySeed[i]!),
      mild: headline(e.mildBySeed[i]!),
      severe: headline(e.severeBySeed[i]!),
    })),
    comparisons: e.comparisons.map((c) => ({
      name: c.name,
      description: c.description,
      policyVersion: c.policyVersion,
      servicingPolicy: c.servicingPolicy,
      gates: c.gates,
      swapSet: c.swapSet,
      base: c.base,
      mild: c.mild,
      throughTheDoor: c.throughTheDoor,
    })),
    challengers: e.challengers.map((c) => ({
      name: c.name,
      description: c.description,
      swapSet: c.swapSet,
      metrics: c.metrics,
    })),
    sensitivities: e.sensitivities.map((c) => ({
      name: c.name,
      description: c.description,
      metrics: c.metrics,
    })),
  });
}

function passThroughSummary(m: PortfolioMetrics) {
  const p = m.passThrough;
  if (!p) return null;
  const g = p.graduated;
  return {
    stats: p.stats,
    graduated: {
      plans: g.plans,
      planMonths: g.planMonths,
      volumeCents: g.volumeCents,
      bad: g.bad,
      badRateBps: g.badRateBps,
      netLossCents: g.netLossCents,
      netLossBps: g.netLossBps,
      netMarginCents: g.netMarginCents,
      netMarginBps: g.netMarginBps,
    },
    bookWithGraduates: {
      netLossBps: p.bookWithGraduates.netLossBps,
      netMarginBps: p.bookWithGraduates.netMarginBps,
      badRateBps: p.bookWithGraduates.badRateBps,
    },
  };
}

function veracitySummary(e: Evaluation) {
  const h = e.base.veracity.honest;
  return {
    honest: {
      applicants: h.applicants,
      knockout: h.knockout,
      refer: h.refer,
      needsInfo: h.needsInfo,
      adverseRateBps: h.adverseRateBps,
      needsInfoRateBps: h.needsInfoRateBps,
      lostUsable: h.lostUsable,
    },
    fraud: Object.fromEntries(
      Object.entries(e.base.veracity.fraud).map(([k, f]) => [
        k,
        { applicants: f.applicants, caught: f.caught, approved: f.approved },
      ]),
    ),
    counterfactualBadRateBps: {
      affected: e.veracityCounterfactual.pooled.affected.badRateBps,
      unaffected: e.veracityCounterfactual.pooled.unaffected.badRateBps,
      unaffectedApprovedUsable: e.veracityCounterfactual.pooled.unaffectedApprovedUsable.badRateBps,
    },
  };
}

/**
 * Headline numbers and gate results for every configuration: small enough to review as a
 * diff. Headlines pool the seeds into one book; gates carry the per seed mean and range.
 */
export function renderBaseline(e: Evaluation): string {
  const configurations: Record<string, unknown> = {};
  for (const c of e.comparisons) {
    configurations[c.name] = {
      policyVersion: c.policyVersion,
      servicingPolicy: c.servicingPolicy,
      gated: false,
      headline: { base: headline(c.base), ...(c.mild ? { mild: headline(c.mild) } : {}) },
      ...(c.throughTheDoor
        ? { throughTheDoor: throughTheDoorSummary(c.throughTheDoor, e.run.seeds) }
        : {}),
      ...(c.gates ? { gates: gateSummary(c.gates) } : {}),
    };
  }
  configurations[e.run.gated] = {
    policyVersion: e.run.policyVersion,
    servicingPolicy: e.run.servicingPolicy,
    gated: true,
    headline: { base: headline(e.base), mild: headline(e.mild), severe: headline(e.severe) },
    throughTheDoor: throughTheDoorSummary(e.throughTheDoor, e.run.seeds),
    gates: gateSummary(e.gates),
    veracity: veracitySummary(e),
    adverseAction: {
      declines: e.base.adverseAction.declines,
      counterOffers: e.base.adverseAction.counterOffers,
      withReasonBps: e.base.adverseAction.withReasonBps,
      declineFirstReasons: e.base.adverseAction.declineFirstReasons,
    },
    ...(e.base.passThrough
      ? {
          passThrough: {
            base: passThroughSummary(e.base),
            mild: passThroughSummary(e.mild),
            severe: passThroughSummary(e.severe),
          },
        }
      : {}),
  };
  // The same decisions and servicing as the gated configuration, with one assumption of the
  // simulation changed. Recorded so a change to either shows up in the diff.
  const sensitivities: Record<string, unknown> = {};
  for (const c of e.sensitivities) sensitivities[c.name] = { base: headline(c.metrics) };
  return stableJson({ run: e.run, configurations, sensitivities });
}
