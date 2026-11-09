import { describe, expect, it } from 'vitest';

import {
  addDays,
  buildInstallmentSchedule,
  daysBetween,
  daysInMonth,
  dueDateInMonth,
  feeForRent,
  followingDueDate,
  nextRentDueDate,
  parseIsoDate,
  splitCents,
} from './schedule';

describe('date helpers', () => {
  it('parses and validates ISO dates', () => {
    expect(parseIsoDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(() => parseIsoDate('2026-02-30')).toThrow();
    expect(() => parseIsoDate('2026-13-01')).toThrow();
    expect(() => parseIsoDate('not a date')).toThrow();
  });

  it('knows month lengths including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-01-01', '2026-02-01')).toBe(31);
    expect(daysBetween('2026-02-01', '2026-01-01')).toBe(-31);
  });
});

describe('rent due dates', () => {
  it('clamps the due day to short months', () => {
    expect(dueDateInMonth(2026, 2, 31)).toBe('2026-02-28');
    expect(dueDateInMonth(2028, 2, 30)).toBe('2028-02-29');
    expect(dueDateInMonth(2026, 4, 31)).toBe('2026-04-30');
    expect(dueDateInMonth(2026, 5, 1)).toBe('2026-05-01');
  });

  it('finds the next due date on or after a given day', () => {
    expect(nextRentDueDate(1, '2026-11-09')).toBe('2026-12-01');
    expect(nextRentDueDate(15, '2026-11-09')).toBe('2026-11-15');
    expect(nextRentDueDate(9, '2026-11-09')).toBe('2026-11-09');
    expect(nextRentDueDate(1, '2026-12-02')).toBe('2027-01-01');
  });

  it('keeps the lease due day when rolling forward from a clamped month', () => {
    expect(followingDueDate('2026-02-28', 31)).toBe('2026-03-31');
    expect(followingDueDate('2026-12-15', 15)).toBe('2027-01-15');
  });
});

describe('money splits', () => {
  it('splits cents exactly with the remainder on the last part', () => {
    expect(splitCents(100, 3)).toEqual([33, 33, 34]);
    expect(splitCents(245000, 2)).toEqual([122500, 122500]);
    expect(splitCents(1, 2)).toEqual([0, 1]);
    expect(splitCents(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('rejects bad inputs', () => {
    expect(() => splitCents(10.5, 2)).toThrow();
    expect(() => splitCents(-1, 2)).toThrow();
    expect(() => splitCents(10, 0)).toThrow();
  });

  it('computes the fee in cents from basis points', () => {
    expect(feeForRent(245000, 250)).toBe(6125); // 2.5% of $2,450
    expect(feeForRent(100000, 0)).toBe(0);
    expect(feeForRent(333, 300)).toBe(10); // 9.99 rounds to 10
  });
});

describe('buildInstallmentSchedule', () => {
  it('builds the default two installment schedule', () => {
    const schedule = buildInstallmentSchedule({
      rentCents: 245000,
      feeBps: 250,
      dueDate: '2026-12-01',
    });

    expect(schedule.periodMonth).toBe('2026-12');
    expect(schedule.payoutDate).toBe('2026-12-01');
    expect(schedule.payoutCents).toBe(245000);
    expect(schedule.feeCents).toBe(6125);
    expect(schedule.installments).toHaveLength(2);

    const [first, second] = schedule.installments;
    // December has 31 days, so spacing is floor(31 / 2) = 15.
    expect(first?.dueDate).toBe('2026-12-01');
    expect(second?.dueDate).toBe('2026-12-16');
    expect(first?.principalCents).toBe(122500);
    expect(second?.principalCents).toBe(122500);
    // Odd fee: 6125 splits as 3062 + 3063.
    expect(first?.feeCents).toBe(3062);
    expect(second?.feeCents).toBe(3063);
    expect(first?.totalCents).toBe(125562);
    expect(second?.totalCents).toBe(125563);
  });

  it('always sums back to rent plus fee', () => {
    for (const n of [1, 2, 3, 4]) {
      for (const rent of [100, 99999, 245000, 1234567]) {
        const s = buildInstallmentSchedule({
          rentCents: rent,
          feeBps: 275,
          dueDate: '2026-02-28',
          installmentsPerMonth: n,
        });
        const principal = s.installments.reduce((a, i) => a + i.principalCents, 0);
        const fee = s.installments.reduce((a, i) => a + i.feeCents, 0);
        const total = s.installments.reduce((a, i) => a + i.totalCents, 0);
        expect(principal).toBe(rent);
        expect(fee).toBe(s.feeCents);
        expect(total).toBe(rent + s.feeCents);
      }
    }
  });

  it('spaces installments across the actual period length', () => {
    // Feb 2026 has 28 days: 4 installments spaced 7 days apart.
    const s = buildInstallmentSchedule({
      rentCents: 200000,
      feeBps: 0,
      dueDate: '2026-02-01',
      installmentsPerMonth: 4,
    });
    expect(s.installments.map((i) => i.dueDate)).toEqual([
      '2026-02-01',
      '2026-02-08',
      '2026-02-15',
      '2026-02-22',
    ]);
  });

  it('keeps all installments strictly before the next due date', () => {
    for (const dueDate of ['2026-01-31', '2026-02-28', '2026-04-30', '2026-12-15']) {
      const { day } = parseIsoDate(dueDate);
      const next = followingDueDate(dueDate, day);
      const s = buildInstallmentSchedule({
        rentCents: 100000,
        feeBps: 250,
        dueDate,
        installmentsPerMonth: 4,
      });
      for (const inst of s.installments) {
        expect(inst.dueDate < next).toBe(true);
      }
    }
  });

  it('rejects unsupported installment counts', () => {
    expect(() =>
      buildInstallmentSchedule({ rentCents: 1000, feeBps: 0, dueDate: '2026-01-01', installmentsPerMonth: 0 }),
    ).toThrow();
    expect(() =>
      buildInstallmentSchedule({ rentCents: 1000, feeBps: 0, dueDate: '2026-01-01', installmentsPerMonth: 5 }),
    ).toThrow();
  });
});
