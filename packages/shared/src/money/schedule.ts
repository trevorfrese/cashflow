/**
 * Pure installment schedule math. No dependencies, no Date-with-timezone surprises.
 * Calendar dates are `YYYY-MM-DD` strings and all arithmetic is done in UTC.
 */

export type IsoDate = string; // YYYY-MM-DD

export interface ScheduleInput {
  /** Monthly rent in integer cents. */
  rentCents: number;
  /** CashFlow fee in basis points of rent. 250 = 2.5%. */
  feeBps: number;
  /** The rent due date for this period. The landlord is paid on this date. */
  dueDate: IsoDate;
  /** How many installments the business repays over the period. Default 2. */
  installmentsPerMonth?: number;
}

export interface ScheduledInstallment {
  /** 1-based position in the period. */
  sequence: number;
  dueDate: IsoDate;
  principalCents: number;
  feeCents: number;
  totalCents: number;
}

export interface PeriodSchedule {
  periodMonth: string; // YYYY-MM
  payoutDate: IsoDate;
  payoutCents: number;
  feeCents: number;
  installments: ScheduledInstallment[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(value);
  if (!m) throw new Error(`Invalid ISO date: ${value}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new Error(`Invalid month in date: ${value}`);
  if (day < 1 || day > daysInMonth(year, month)) throw new Error(`Invalid day in date: ${value}`);
  return { year, month, day };
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Whole days from `a` to `b`. Positive when `b` is after `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  const ta = Date.UTC(pa.year, pa.month - 1, pa.day);
  const tb = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((tb - ta) / 86_400_000);
}

/** `YYYY-MM` for a date. */
export function periodMonthOf(date: IsoDate): string {
  const { year, month } = parseIsoDate(date);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

/**
 * The rent due date in a given month for a lease that is due on `dueDayOfMonth`.
 * Clamps to the last day of short months (due day 31 in February becomes the 28th or 29th).
 */
export function dueDateInMonth(year: number, month: number, dueDayOfMonth: number): IsoDate {
  if (dueDayOfMonth < 1 || dueDayOfMonth > 31) {
    throw new Error(`dueDayOfMonth must be 1..31, got ${dueDayOfMonth}`);
  }
  const day = Math.min(dueDayOfMonth, daysInMonth(year, month));
  return toIsoDate(year, month, day);
}

/**
 * The first rent due date on or after `from` for a lease due on `dueDayOfMonth`.
 */
export function nextRentDueDate(dueDayOfMonth: number, from: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(from);
  const thisMonth = dueDateInMonth(year, month, dueDayOfMonth);
  if (thisMonth >= from) return thisMonth;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return dueDateInMonth(nextYear, nextMonth, dueDayOfMonth);
}

/** The due date one month after `dueDate`, keeping the lease's due day of month. */
export function followingDueDate(dueDate: IsoDate, dueDayOfMonth: number): IsoDate {
  const { year, month } = parseIsoDate(dueDate);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return dueDateInMonth(nextYear, nextMonth, dueDayOfMonth);
}

/**
 * Split `totalCents` into `parts` integer amounts that sum exactly to the total.
 * The remainder from integer division lands on the last part.
 */
export function splitCents(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error(`totalCents must be a non-negative integer, got ${totalCents}`);
  }
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error(`parts must be a positive integer, got ${parts}`);
  }
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  const out = new Array<number>(parts).fill(base);
  out[parts - 1] = base + remainder;
  return out;
}

/** CashFlow's fee for one period, in cents. Rounded half up. */
export function feeForRent(rentCents: number, feeBps: number): number {
  if (!Number.isInteger(rentCents) || rentCents < 0) {
    throw new Error(`rentCents must be a non-negative integer, got ${rentCents}`);
  }
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error(`feeBps must be a non-negative integer, got ${feeBps}`);
  }
  return Math.round((rentCents * feeBps) / 10_000);
}

/**
 * Build one period's schedule.
 *
 * The landlord is paid the full rent on `dueDate`. The business repays principal plus fee
 * in `installmentsPerMonth` installments. The first installment is collected on the due date
 * and the rest are spaced evenly across the period, where the period length is the number of
 * days until the next due date. With 2 installments in a 30 day month that is the due date
 * and the due date plus 15 days.
 */
export function buildInstallmentSchedule(input: ScheduleInput): PeriodSchedule {
  const installmentsPerMonth = input.installmentsPerMonth ?? 2;
  if (
    !Number.isInteger(installmentsPerMonth) ||
    installmentsPerMonth < 1 ||
    installmentsPerMonth > 4
  ) {
    throw new Error(`installmentsPerMonth must be 1..4, got ${installmentsPerMonth}`);
  }
  const { day } = parseIsoDate(input.dueDate);
  const periodEnd = followingDueDate(input.dueDate, day);
  const periodDays = daysBetween(input.dueDate, periodEnd);
  const spacing = Math.floor(periodDays / installmentsPerMonth);

  const feeCents = feeForRent(input.rentCents, input.feeBps);
  const principalParts = splitCents(input.rentCents, installmentsPerMonth);
  const feeParts = splitCents(feeCents, installmentsPerMonth);

  const installments: ScheduledInstallment[] = principalParts.map((principalCents, i) => {
    const partFee = feeParts[i] ?? 0;
    return {
      sequence: i + 1,
      dueDate: addDays(input.dueDate, spacing * i),
      principalCents,
      feeCents: partFee,
      totalCents: principalCents + partFee,
    };
  });

  return {
    periodMonth: periodMonthOf(input.dueDate),
    payoutDate: input.dueDate,
    payoutCents: input.rentCents,
    feeCents,
    installments,
  };
}
