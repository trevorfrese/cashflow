import type { IsoDate } from '@cashflow/shared';
import { daysBetween, toIsoDate } from '@cashflow/shared';

const isoOf = (d: Date): IsoDate =>
  toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

/**
 * The simulated date of the dev clock, or null. Null in every process that has not turned
 * dev tools on: only `src/dev/clock.ts` sets it, and that module is only reached with
 * `ENABLE_DEV_TOOLS=true`, which the API refuses in production. While it is null, every
 * function in this file reads the wall clock and nothing else.
 */
let devClockDate: IsoDate | null = null;

/**
 * Pin "today" to a simulated date, or pass null to go back to the wall clock. A date that is
 * not ahead of the wall clock is the same as null: the dev clock only ever runs forward.
 * Dev tools only. See `src/dev/clock.ts`.
 */
export function setDevClockDate(date: IsoDate | null): void {
  devClockDate = date;
}

/** The pinned simulated date when it is ahead of the wall clock, otherwise null. */
export function devClockAhead(wallNow: Date = new Date()): IsoDate | null {
  return devClockDate !== null && devClockDate > isoOf(wallNow) ? devClockDate : null;
}

/**
 * The current instant. The wall clock, unless the dev clock is ahead: then the same time of
 * day on the simulated date, so timestamps written "now" land on the day `todayIso()` says
 * it is. Use this, not `new Date()`, for a timestamp that records when business happened.
 */
export function clockNow(): Date {
  const wall = new Date();
  const ahead = devClockAhead(wall);
  if (!ahead) return wall;
  return new Date(wall.getTime() + daysBetween(isoOf(wall), ahead) * 86_400_000);
}

/** Today's calendar date in UTC as YYYY-MM-DD. Pass `now` to read a specific instant. */
export function todayIso(now?: Date): IsoDate {
  return isoOf(now ?? clockNow());
}

/** Months between two YYYY-MM-DD dates, ignoring days. Used for time in business. */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}

/**
 * Timestamp to stamp on records produced by a job running "as of" a calendar date. For today
 * that is the current instant; for a replayed past date (seeds, backfills, demos) it is
 * midday UTC on that date, so history reads correctly instead of everything landing on the
 * replay day.
 */
export function effectiveAt(asOf: IsoDate, now: Date = clockNow()): Date {
  if (asOf === todayIso(now)) return now;
  return new Date(`${asOf}T12:00:00.000Z`);
}
