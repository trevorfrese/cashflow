import type { BankTransaction, DailySales, IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import type { VeracityPolicy } from './types.ts';

/**
 * Consistency over time: does a new pull agree with an earlier one about the days both
 * cover, once those days were final.
 *
 * The overlap runs from the later of the two windows' starts to the earlier pull's end, less
 * `pendingToleranceDays`: transactions in the last few days of a pull can still post, settle
 * at a different amount (a tip adjustment), or drop off (a pending item that never posted).
 * Pending transactions are left out entirely.
 *
 * Bank transactions are compared by date and amount, not by id or description: aggregators
 * reissue ids and recategorize on a re-sync, which is not a change to what happened. Each
 * (date, amount) is counted, so a duplicate that appears or disappears is a change. A removed
 * and an added item on the same date count once, as one altered item.
 *
 * A change is "flattering" when it helps the applicant: a debit removed, or a credit added.
 */

export interface HistoryDiff {
  overlapFrom: IsoDate;
  overlapTo: IsoDate;
  removed: number;
  added: number;
  altered: number;
  /** Removed plus added plus altered. */
  changedItems: number;
  changedAmountCents: number;
  overlapVolumeCents: number;
  changedShareBps: number;
  /** Net effect in the applicant's favour, in cents (positive flatters). */
  flatteringCents: number;
  /** Items whose change flatters: a debit gone, or a credit new. */
  flatteringItems: number;
  material: boolean;
}

interface Window {
  windowFrom: IsoDate;
  windowTo: IsoDate;
}

function overlap(current: Window, prior: Window, tolerance: number) {
  const from = current.windowFrom > prior.windowFrom ? current.windowFrom : prior.windowFrom;
  const end = addDays(prior.windowTo, -tolerance);
  const to = current.windowTo < end ? current.windowTo : end;
  return from <= to ? { from, to } : null;
}

const bps = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 10_000) / d));

function summarize(
  from: IsoDate,
  to: IsoDate,
  removed: Array<{ date: IsoDate; amountCents: number }>,
  added: Array<{ date: IsoDate; amountCents: number }>,
  volume: number,
  policy: VeracityPolicy['consistency'],
): HistoryDiff {
  const addedByDate = new Map<IsoDate, number>();
  for (const a of added) addedByDate.set(a.date, (addedByDate.get(a.date) ?? 0) + 1);
  let altered = 0;
  for (const r of removed) {
    const n = addedByDate.get(r.date) ?? 0;
    if (n > 0) {
      addedByDate.set(r.date, n - 1);
      altered++;
    }
  }
  const changedAmount =
    removed.reduce((s, r) => s + Math.abs(r.amountCents), 0) +
    added.reduce((s, a) => s + Math.abs(a.amountCents), 0);
  const flatteringCents =
    added.reduce((s, a) => s + a.amountCents, 0) - removed.reduce((s, r) => s + r.amountCents, 0);
  const flatteringItems =
    removed.filter((r) => r.amountCents < 0).length + added.filter((a) => a.amountCents > 0).length;
  const changedItems = removed.length + added.length - altered;
  const changedShareBps = bps(changedAmount, volume);
  return {
    overlapFrom: from,
    overlapTo: to,
    removed: removed.length - altered,
    added: added.length - altered,
    altered,
    changedItems,
    changedAmountCents: changedAmount,
    overlapVolumeCents: volume,
    changedShareBps,
    flatteringCents,
    flatteringItems,
    material: changedItems >= policy.materialItems || changedShareBps >= policy.materialShareBps,
  };
}

export function diffBankHistory(
  current: Window & { transactions: readonly BankTransaction[] },
  prior: Window & { transactions: readonly BankTransaction[] },
  policy: VeracityPolicy['consistency'],
): HistoryDiff | null {
  const span = overlap(current, prior, policy.pendingToleranceDays);
  if (!span) return null;
  const inSpan = (t: BankTransaction) => !t.pending && t.date >= span.from && t.date <= span.to;
  const key = (t: BankTransaction) => `${t.date}|${t.amountCents}`;
  const counts = new Map<string, number>();
  let volume = 0;
  for (const t of prior.transactions) {
    if (!inSpan(t)) continue;
    counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
    volume += Math.abs(t.amountCents);
  }
  const added: BankTransaction[] = [];
  for (const t of current.transactions) {
    if (!inSpan(t)) continue;
    const n = counts.get(key(t)) ?? 0;
    if (n > 0) counts.set(key(t), n - 1);
    else added.push(t);
  }
  const removed: Array<{ date: IsoDate; amountCents: number }> = [];
  for (const [k, n] of counts) {
    if (n <= 0) continue;
    const [date, amount] = k.split('|') as [IsoDate, string];
    for (let i = 0; i < n; i++) removed.push({ date, amountCents: Number(amount) });
  }
  return summarize(span.from, span.to, removed, added, volume, policy);
}

/**
 * Daily sales compared by date. A day whose gross, refunds or chargebacks moved by more than
 * a dollar or 1% (whichever is larger) is one altered item. Gross up or refunds down flatters.
 */
export function diffSalesHistory(
  current: Window & { dailySales: readonly DailySales[] },
  prior: Window & { dailySales: readonly DailySales[] },
  policy: VeracityPolicy['consistency'],
): HistoryDiff | null {
  const span = overlap(current, prior, policy.pendingToleranceDays);
  if (!span) return null;
  const inSpan = (d: DailySales) => d.date >= span.from && d.date <= span.to;
  const net = (d: DailySales) => d.grossCents - d.refundsCents - d.chargebacksCents;
  const before = new Map(prior.dailySales.filter(inSpan).map((d) => [d.date, d]));
  const after = new Map(current.dailySales.filter(inSpan).map((d) => [d.date, d]));
  const removed: Array<{ date: IsoDate; amountCents: number }> = [];
  const added: Array<{ date: IsoDate; amountCents: number }> = [];
  let volume = 0;
  let up = 0;
  for (const d of before.values()) volume += Math.abs(net(d));
  for (const date of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(date);
    const b = after.get(date);
    const na = a ? net(a) : 0;
    const nb = b ? net(b) : 0;
    if (Math.abs(nb - na) <= Math.max(100, Math.round(Math.abs(na) / 100))) continue;
    if (nb > na) up++;
    if (a) removed.push({ date, amountCents: na });
    if (b) added.push({ date, amountCents: nb });
  }
  return { ...summarize(span.from, span.to, removed, added, volume, policy), flatteringItems: up };
}
