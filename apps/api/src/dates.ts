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
