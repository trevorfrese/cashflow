import type {
  BankTransaction,
  CommercePlatform,
  DailySales,
  IsoDate,
  PlatformPayout,
  SettlementReconciliation,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS, addDays, daysBetween } from '@cashflow/shared';

import type { VeracityPolicy } from './types.ts';

/**
 * Settlement reconciliation: each platform payout against the bank deposits it should have
 * become.
 *
 * Window: payouts dated in the `windowDays` before the decision, leaving out the last
 * `inTransitDays` (still on their way). Payouts the platform says it sent to an account that
 * is not connected are counted apart: we cannot expect to see them.
 *
 * A payout matches a deposit when the deposit posts from `daysBefore` days before to
 * `daysAfter` days after the payout's date (weekends, holds, a slow bank) and the amounts
 * agree within the larger of `toleranceBps` and `toleranceMinCents` (the payout amount is
 * already net of fees, refunds and chargebacks; the tolerance absorbs a bank's rounding or a
 * small adjustment). Three passes, each greedy in date order so the result is deterministic:
 *
 *   1. one payout to one deposit;
 *   2. one payout split across up to `maxCombine` deposits (a bank that splits a transfer);
 *   3. up to `maxCombine` payouts in one deposit (batching, or several locations paid
 *      together).
 *
 * Deposits that name the platform in their description and match no payout are counted as
 * "claimed": revenue that says it came from the platform when the platform has no record of
 * it.
 */

const ELIGIBLE = new Set(['CARD_SETTLEMENT', 'OTHER_INCOME', 'INVOICE_PAYMENT']);

const bps = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 10_000) / d));

export interface ReconcileInput {
  asOf: IsoDate;
  platform: CommercePlatform;
  connectionId: string | null;
  payouts: readonly PlatformPayout[];
  /** Credits from every connected bank account. */
  deposits: readonly BankTransaction[];
  /** Masks of every connected bank account. */
  linkedMasks: ReadonlySet<string>;
  dailySales: readonly DailySales[];
}

/** The card part of net sales: what a platform has to pay out, before its fees. */
export function cardNetCents(d: DailySales): number {
  return Math.max(
    0,
    Math.round((d.grossCents * d.cardShareBps) / 10_000) - d.refundsCents - d.chargebacksCents,
  );
}

export function reconcileSettlements(
  input: ReconcileInput,
  policy: VeracityPolicy['reconciliation'],
): SettlementReconciliation {
  const from = addDays(input.asOf, -(policy.windowDays - 1));
  const to = addDays(input.asOf, -policy.inTransitDays);
  const inWindow = input.payouts
    .filter((p) => p.date >= from && p.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  const unlinked = inWindow.filter(
    (p) => p.destinationMask !== null && !input.linkedMasks.has(p.destinationMask),
  );
  const considered = inWindow.filter((p) => !unlinked.includes(p));

  const deposits = input.deposits
    .filter(
      (t) =>
        !t.pending &&
        t.amountCents > 0 &&
        ELIGIBLE.has(t.category) &&
        t.date >= addDays(from, -policy.daysBefore) &&
        t.date <= addDays(to, policy.daysAfter),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

  const usedDeposit = new Set<number>();
  const matchedPayout = new Set<number>();
  const tolerance = (cents: number) =>
    Math.max(policy.toleranceMinCents, Math.round((cents * policy.toleranceBps) / 10_000));
  const near = (payoutDate: IsoDate, depositDate: IsoDate) => {
    const d = daysBetween(payoutDate, depositDate);
    return d >= -policy.daysBefore && d <= policy.daysAfter;
  };
  // Deposits by index window, for speed: deposits are sorted by date.
  const depositsNear = (date: IsoDate): number[] => {
    const out: number[] = [];
    for (let k = 0; k < deposits.length; k++) {
      if (usedDeposit.has(k)) continue;
      const dd = deposits[k]!.date;
      if (dd > addDays(date, policy.daysAfter)) break;
      if (near(date, dd)) out.push(k);
    }
    return out;
  };

  // 1. One to one, the closest date first.
  considered.forEach((p, i) => {
    const tol = tolerance(p.amountCents);
    const candidates = depositsNear(p.date)
      .filter((k) => Math.abs(deposits[k]!.amountCents - p.amountCents) <= tol)
      .sort(
        (a, b) =>
          Math.abs(daysBetween(p.date, deposits[a]!.date)) -
          Math.abs(daysBetween(p.date, deposits[b]!.date)),
      );
    const k = candidates[0];
    if (k === undefined) return;
    usedDeposit.add(k);
    matchedPayout.add(i);
  });

  // 2. One payout split across several deposits.
  considered.forEach((p, i) => {
    if (matchedPayout.has(i)) return;
    const tol = tolerance(p.amountCents);
    const pool = depositsNear(p.date).filter((k) => deposits[k]!.amountCents < p.amountCents + tol);
    const combo = findCombination(
      pool,
      (k) => deposits[k]!.amountCents,
      p.amountCents,
      tol,
      policy.maxCombine,
    );
    if (!combo) return;
    combo.forEach((k) => usedDeposit.add(k));
    matchedPayout.add(i);
  });

  // 3. Several payouts in one deposit.
  deposits.forEach((d, k) => {
    if (usedDeposit.has(k)) return;
    const tol = tolerance(d.amountCents);
    const pool: number[] = [];
    considered.forEach((p, i) => {
      if (!matchedPayout.has(i) && near(p.date, d.date) && p.amountCents < d.amountCents + tol) {
        pool.push(i);
      }
    });
    const combo = findCombination(
      pool,
      (i) => considered[i]!.amountCents,
      d.amountCents,
      tol,
      policy.maxCombine,
    );
    if (!combo) return;
    combo.forEach((i) => matchedPayout.add(i));
    usedDeposit.add(k);
  });

  const amount = (list: readonly PlatformPayout[]) => list.reduce((s, p) => s + p.amountCents, 0);
  const matched = considered.filter((_, i) => matchedPayout.has(i));
  const unmatched = considered.filter((_, i) => !matchedPayout.has(i));

  const label = COMMERCE_PLATFORM_LABELS[input.platform].toUpperCase();
  const claimed = deposits.filter(
    (t, k) =>
      !usedDeposit.has(k) &&
      t.date >= from &&
      t.date <= to &&
      t.description.toUpperCase().includes(label),
  );
  const claimedRelevant = considered.length >= policy.minPayouts;

  const salesFrom = addDays(from, -1);
  const salesTo = addDays(to, -1);
  const cardSales = input.dailySales
    .filter((d) => d.date >= salesFrom && d.date <= salesTo)
    .reduce((s, d) => s + cardNetCents(d), 0);
  const allPayouts = amount(inWindow);

  return {
    connectionId: input.connectionId,
    payoutsConsidered: considered.length,
    payoutsAmountCents: amount(considered),
    matchedCount: matched.length,
    matchedAmountCents: amount(matched),
    matchedShareByCountBps: considered.length > 0 ? bps(matched.length, considered.length) : null,
    matchedShareByAmountBps:
      considered.length > 0 ? Math.min(10_000, bps(amount(matched), amount(considered))) : null,
    unlinkedPayouts: unlinked.length,
    unlinkedAmountCents: amount(unlinked),
    claimedUnmatchedDeposits: claimedRelevant ? claimed.length : 0,
    claimedUnmatchedAmountCents: claimedRelevant
      ? claimed.reduce((s, t) => s + t.amountCents, 0)
      : 0,
    payoutToCardSalesBps: cardSales > 0 && inWindow.length > 0 ? bps(allPayouts, cardSales) : null,
    unmatchedSample: unmatched
      .slice(0, 10)
      .map((p) => ({ id: p.id, date: p.date, amountCents: p.amountCents })),
  };
}

/**
 * A combination of 2 to `max` items whose amounts sum to `target` within `tol`. Contiguous
 * runs in date order first (the common case: a batch, or locations paid the same day), then
 * any pair. Deterministic. Null when there is none.
 */
function findCombination(
  pool: readonly number[],
  amountOf: (k: number) => number,
  target: number,
  tol: number,
  max: number,
): number[] | null {
  for (let start = 0; start < pool.length; start++) {
    let sum = 0;
    for (let end = start; end < pool.length && end - start < max; end++) {
      sum += amountOf(pool[end]!);
      if (end > start && Math.abs(sum - target) <= tol) return pool.slice(start, end + 1);
      if (sum > target + tol) break;
    }
  }
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      if (Math.abs(amountOf(pool[a]!) + amountOf(pool[b]!) - target) <= tol) {
        return [pool[a]!, pool[b]!];
      }
    }
  }
  return null;
}
