import type { IsoDate } from '@cashflow/shared';
import { toIsoDate } from '@cashflow/shared';

/** Today's calendar date in UTC as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): IsoDate {
  return toIsoDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

/** Months between two YYYY-MM-DD dates, ignoring days. Used for time in business. */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}

/**
 * Timestamp to stamp on records produced by a job running "as of" a calendar date. For today
 * that is the real clock; for a replayed past date (seeds, backfills, demos) it is midday UTC
 * on that date, so history reads correctly instead of everything landing on the replay day.
 */
export function effectiveAt(asOf: IsoDate, now: Date = new Date()): Date {
  if (asOf === todayIso(now)) return now;
  return new Date(`${asOf}T12:00:00.000Z`);
}
