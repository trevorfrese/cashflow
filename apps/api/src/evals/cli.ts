/**
 * Portfolio evaluation runner.
 *
 *   pnpm --filter @cashflow/api eval:portfolio                 # 5 seeds, about 2.5 minutes
 *   pnpm --filter @cashflow/api eval:portfolio --seeds 1       # one seed, about 35 seconds
 *   pnpm --filter @cashflow/api eval:portfolio --n 500 --seeds 7,8 --horizon 6 --out /tmp/evals
 *   pnpm --filter @cashflow/api eval:portfolio --strict        # exit 1 if any gate fails
 *
 * Runs the current credit policy under the standard servicing policy (the gated
 * configuration) and the comparison configurations on every seed, and judges the gates on
 * the mean across seeds. Writes report.md and report.json to the output directory (default
 * apps/api/evals). The checked in baseline.json is rewritten only by a run with the default
 * n, seeds, and horizon, so it always describes the same experiment.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allGatesPass } from './gates.ts';
import { renderBaseline, renderJson, renderMarkdown } from './report.ts';
import { CHALLENGERS, DEFAULT_RUN, evaluate, SENSITIVITIES } from './run.ts';

interface Args {
  n: number;
  seeds: string[];
  horizonMonths: number;
  out: string;
  strict: boolean;
}

function readArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const v = argv[idx + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const positiveInt = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${flag} must be a positive integer, got ${raw}`);
    }
    return parsed;
  };
  const known = new Set(['--n', '--seeds', '--seed', '--horizon', '--out', '--strict']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`Unknown flag ${arg}`);
  }
  return {
    n: positiveInt('--n', DEFAULT_RUN.n),
    // `--seed` is kept as an alias for a single seed.
    seeds: (value('--seeds') ?? value('--seed') ?? DEFAULT_RUN.seeds.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    horizonMonths: positiveInt('--horizon', DEFAULT_RUN.horizonMonths),
    out: resolve(value('--out') ?? fileURLToPath(new URL('../../evals', import.meta.url))),
    strict: argv.includes('--strict'),
  };
}

const args = readArgs(process.argv.slice(2));
const started = performance.now();
const evaluation = evaluate({
  n: args.n,
  seeds: args.seeds,
  horizonMonths: args.horizonMonths,
  challengers: CHALLENGERS,
  sensitivities: SENSITIVITIES,
});
const seconds = ((performance.now() - started) / 1000).toFixed(1);

mkdirSync(args.out, { recursive: true });
writeFileSync(resolve(args.out, 'report.md'), renderMarkdown(evaluation));
writeFileSync(resolve(args.out, 'report.json'), renderJson(evaluation));
const isDefaultRun =
  args.n === DEFAULT_RUN.n &&
  args.seeds.join(',') === DEFAULT_RUN.seeds.join(',') &&
  args.horizonMonths === DEFAULT_RUN.horizonMonths;
if (isDefaultRun) writeFileSync(resolve(args.out, 'baseline.json'), renderBaseline(evaluation));

const o = evaluation.base.overall;
const fundedAucs = evaluation.baseBySeed.map((m) => m.rankOrdering.auc);
const fundedOnlyAuc = fundedAucs.every((v): v is number => v !== null)
  ? `${(fundedAucs.reduce((a, b) => a + b, 0) / fundedAucs.length).toFixed(3)} [${Math.min(...fundedAucs).toFixed(3)} to ${Math.max(...fundedAucs).toFixed(3)}]`
  : 'n/a';
const lines = [
  `Portfolio evaluation: ${args.n} applicants x seeds ${args.seeds.join(',')}, ${args.horizonMonths} periods, ${seconds}s`,
  `  ${evaluation.run.policyVersion} with ${evaluation.run.servicingPolicy} servicing`,
  `  approval ${(o.approvalRateBps / 100).toFixed(1)}%  bad rate ${(o.badRateBps / 100).toFixed(1)}%  net loss ${o.netLossBps} bps  net margin ${o.netMarginBps} bps`,
  ...evaluation.gates.map(
    (g) =>
      `  ${g.pass ? 'PASS' : 'FAIL'}  ${g.id}: ${g.value ?? 'n/a'} [${g.min ?? 'n/a'} to ${g.max ?? 'n/a'}] (${g.comparator} ${g.threshold} ${g.unit})`,
  ),
  `  auc is judged through the door on honest applicants. Funded plans only, not gated: ${fundedOnlyAuc}`,
  `Wrote report.md and report.json${isDefaultRun ? ' and baseline.json' : ''} to ${args.out}`,
  isDefaultRun ? '' : 'baseline.json not written: this is not the default run.',
].filter((l) => l !== '');
process.stdout.write(`${lines.join('\n')}\n`);

if (args.strict && !allGatesPass(evaluation.gates)) process.exitCode = 1;
