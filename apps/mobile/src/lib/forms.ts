import { parseIsoDate, toIsoDate } from '@cashflow/shared';

/**
 * Parse a dollars string typed by a person ("2,450", "$2450.50") into integer cents.
 * Returns null when the input is not a valid non negative amount.
 */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Parse a whole percentage typed by a person ("100", "25%") into basis points, which is how
 * the API takes an ownership share. Returns null unless it is from 1 to 100.
 */
export function percentToBps(input: string): number | null {
  const cleaned = input.replace(/[%\s]/g, '');
  if (!/^\d{1,3}$/.test(cleaned)) return null;
  const percent = Number(cleaned);
  return percent >= 1 && percent <= 100 ? percent * 100 : null;
}

/** Format cents back into an editable dollars string with no symbol. */
export function centsToDollarsInput(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return rem === 0 ? String(dollars) : `${dollars}.${String(rem).padStart(2, '0')}`;
}

/** Accept "YYYY-MM" or "YYYY-MM-DD" and return a valid first-of-month or exact ISO date. */
export function normalizeMonthInput(input: string): string | null {
  const trimmed = input.trim();
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(trimmed);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = m[3] ? Number(m[3]) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  try {
    const iso = toIsoDate(year, month, day);
    parseIsoDate(iso);
    return iso;
  } catch {
    return null;
  }
}

/** Whole months between an ISO date and today (or `now`). Never negative. */
export function monthsSince(iso: string, now: Date = new Date()): number {
  const { year, month } = parseIsoDate(iso);
  const months = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month);
  return Math.max(0, months);
}

let simulatedToday: string | null = null;

/**
 * Dev menu only: make `todayIso()` return the API's simulated date, or pass null to go back
 * to the device clock. Nothing calls this unless the dev tools flag is set.
 */
export function setSimulatedToday(date: string | null): void {
  simulatedToday = date;
}

/** Today as YYYY-MM-DD in UTC, matching how the API reasons about calendar dates. */
export function todayIso(now?: Date): string {
  if (!now && simulatedToday) return simulatedToday;
  const d = now ?? new Date();
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** "2026-11-16" to "Nov 16, 2026". */
export function formatDate(iso: string): string {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-11" to "November 2026". */
export function formatPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Ordinal day label, 1 to "1st". */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
