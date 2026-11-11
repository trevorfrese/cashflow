import { daysBetween, formatBps, formatCents, type AlertSeverity } from '@cashflow/shared';

/**
 * Formatting for the console. One place, so a date, an amount, or a rate reads the same on
 * every page. Money comes in integer cents, rates in basis points, calendar dates as
 * YYYY-MM-DD, and timestamps as ISO 8601 in UTC. Dates and times are shown in UTC because
 * the API's "today" is the UTC date, and a due date must not shift with the viewer's zone.
 */

/** Shown where there is no value. */
export const NONE = '-';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Integer cents as dollars: 245000 is "$2,450.00". Whole dollars with `whole`. */
export function money(cents: number | null | undefined, options: { whole?: boolean } = {}): string {
  if (cents === null || cents === undefined) return NONE;
  return formatCents(cents, { showCents: !options.whole });
}

/** Basis points as a percentage: 250 is "2.5%", 9 is "0.09%". Fractions are rounded to 0.01%. */
export function percent(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return NONE;
  if (Number.isInteger(bps)) return formatBps(bps);
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** A calendar date: "2026-11-07" is "Nov 7, 2026". */
export function date(value: string | null | undefined): string {
  if (!value) return NONE;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** A period: "2026-11" is "Nov 2026". */
export function month(value: string | null | undefined): string {
  if (!value) return NONE;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : value;
}

/** A timestamp: "2026-11-07T14:05:00.000Z" is "Nov 7, 2026 14:05 UTC". */
export function dateTime(value: string | null | undefined): string {
  if (!value) return NONE;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const iso = parsed.toISOString();
  return `${date(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
}

/** Today's calendar date in UTC, the same "today" the API uses. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A count of days in words: 0 is "today", 1 is "1 day", 34 is "34 days". */
export function days(count: number | null | undefined): string {
  if (count === null || count === undefined) return NONE;
  if (count === 0) return 'today';
  return `${count} ${Math.abs(count) === 1 ? 'day' : 'days'}`;
}

/** How long ago a timestamp was, in whole days: "today", "1 day ago", "34 days ago". */
export function age(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return NONE;
  const elapsed = daysBetween(value.slice(0, 10), todayUtc(now));
  if (elapsed <= 0) return 'today';
  return `${days(elapsed)} ago`;
}

/** `IN_REVIEW` is "In review", `rent_plan` is "Rent plan". */
export function words(code: string | null | undefined): string {
  if (!code) return NONE;
  const text = code
    .replace(/[_.:-]+/g, ' ')
    .trim()
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export interface Deadline {
  tone: Tone;
  /** Short text for a tag: "Due in 5 days", "Due today", "4 days overdue". */
  label: string;
  /** Whole days left. Negative when the date has passed. */
  daysLeft: number;
}

/**
 * Where an application stands against its notice deadline. It warns from ten days out,
 * which is when monitoring opens its warning (20 of the 30 days used), and is late from the
 * due date itself, when monitoring goes critical.
 */
export function deadline(
  dueOn: string | null | undefined,
  today: string = todayUtc(),
  warnWithinDays = 10,
): Deadline | null {
  if (!dueOn) return null;
  const daysLeft = daysBetween(today, dueOn);
  if (daysLeft < 0) return { tone: 'bad', label: `${days(-daysLeft)} overdue`, daysLeft };
  if (daysLeft === 0) return { tone: 'bad', label: 'Due today', daysLeft };
  return {
    tone: daysLeft <= warnWithinDays ? 'warn' : 'neutral',
    label: `Due in ${days(daysLeft)}`,
    daysLeft,
  };
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { CRITICAL: 0, HIGH: 1, WARNING: 2, INFO: 3 };

/** Most severe first, then oldest first: the order to work a queue in. */
export function bySeverityThenAge<T extends { severity: AlertSeverity; createdAt: string }>(
  alerts: readonly T[],
): T[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** A value from a policy parameter or an alert detail, formatted by its unit. */
export function byUnit(value: number | string | boolean | null | undefined, unit: string): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  switch (unit) {
    case 'cents':
      return money(value, { whole: value % 100 === 0 });
    case 'bps':
      return percent(value);
    case 'days':
      return days(value).replace('today', '0 days');
    case 'months':
      return `${value} ${value === 1 ? 'month' : 'months'}`;
    case 'ratio':
      return `${value}x`;
    default:
      return value.toLocaleString('en-US');
  }
}

/** A gate's value or threshold in its own unit: cents as money, rates with their percent. */
export function gateNumber(value: number | null, unit: string): string {
  if (value === null) return 'Not measurable';
  if (unit === 'cents') return money(value, { whole: true });
  if (unit.startsWith('bps')) return `${value.toLocaleString('en-US')} bps (${percent(value)})`;
  if (unit === 'AUC') return value.toFixed(3);
  return value.toLocaleString('en-US');
}

const COMPARATORS: Record<string, string> = {
  '<=': 'at most',
  '>=': 'at least',
  '>': 'above',
  '<': 'below',
  '=': 'exactly',
};

export function comparator(symbol: string): string {
  return COMPARATORS[symbol] ?? symbol;
}

export interface DetailRow {
  key: string;
  label: string;
  value: string;
}

/** `daysPastDue` is "Days past due", `rateBps` is "Rate", `owedCents` is "Owed". */
export function fieldLabel(key: string): string {
  const spaced = key
    .replace(/(Cents|Bps)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One value out of an alert's detail or an audit payload, formatted by what its key says. */
export function fieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return NONE;
  if (typeof value === 'number') {
    if (/Cents$/.test(key)) return money(value);
    if (/Bps$/.test(key)) return percent(value);
    return value.toLocaleString('en-US');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return dateTime(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date(value);
    if (/^\d{4}-\d{2}$/.test(value)) return month(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      const shown = value.slice(0, 8).join(', ');
      return value.length > 8 ? `${shown} and ${value.length - 8} more` : shown;
    }
  }
  return JSON.stringify(value);
}

/** An alert's detail or an audit payload as rows a person can read. */
export function detailRows(detail: Record<string, unknown>): DetailRow[] {
  return Object.entries(detail).map(([key, value]) => ({
    key,
    label: fieldLabel(key),
    value: fieldValue(key, value),
  }));
}

export interface Measure {
  label: string;
  value: string;
  threshold: string;
  /** What the threshold is: "cap", "critical at", "deadline". */
  thresholdLabel: string;
}

/**
 * The measured value of an alert against the threshold that raised it, where the detail
 * carries both. Rules store their numbers under a few recurring pairs of keys.
 */
export function measures(detail: Record<string, unknown>): Measure[] {
  const num = (key: string) => (typeof detail[key] === 'number' ? (detail[key] as number) : null);
  const out: Measure[] = [];
  const pair = (
    valueKey: string,
    thresholdKey: string,
    label: string,
    thresholdLabel: string,
    format: (n: number) => string,
  ) => {
    const value = num(valueKey);
    const threshold = num(thresholdKey);
    if (value === null || threshold === null) return;
    out.push({ label, value: format(value), threshold: format(threshold), thresholdLabel });
  };
  pair('rateBps', 'thresholdBps', 'Rate', 'threshold', percent);
  pair('rateBps', 'warnBps', 'Rate', 'warning at', percent);
  pair('rateBps', 'criticalBps', 'Rate', 'critical at', percent);
  pair('shareBps', 'capBps', 'Share of pool capital', 'cap', percent);
  pair('shareBps', 'warnBps', 'Share', 'warning at', percent);
  pair('shareBps', 'criticalBps', 'Share', 'critical at', percent);
  pair('utilizationBps', 'ceilingBps', 'Pool utilization', 'ceiling', percent);
  pair('ratioBps', 'warnBps', 'Realized over expected loss', 'warning at', percent);
  pair('ratioBps', 'criticalBps', 'Realized over expected loss', 'critical at', percent);
  pair('count', 'threshold', 'Count', 'threshold', (n) => n.toLocaleString('en-US'));
  if (typeof detail.daysWaiting === 'number' && typeof detail.deadline === 'string') {
    out.push({
      label: 'Waiting',
      value: days(detail.daysWaiting),
      threshold: date(detail.deadline),
      thresholdLabel: 'deadline',
    });
  }
  // Two pairs can describe the same comparison. Keep the first of each.
  const seen = new Set<string>();
  return out.filter((m) => {
    const id = `${m.label}|${m.thresholdLabel}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Dollars typed into a form as integer cents. Null when it is not an amount. */
export function parseDollars(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** A percentage typed into a form as basis points. Null when it is not a rate. */
export function parsePercent(text: string): number | null {
  const cleaned = text.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Cents as the text a dollars field starts with: 360000 is "3600", 360050 is "3600.50". */
export function dollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Basis points as the text a percent field starts with: 150 is "1.5". */
export function percentInput(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '';
  return String(bps / 100);
}
