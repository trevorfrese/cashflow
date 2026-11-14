import { describe, expect, it } from 'vitest';

import {
  age,
  bySeverityThenAge,
  byUnit,
  comparator,
  date,
  dateTime,
  days,
  deadline,
  detailRows,
  dollarsInput,
  fieldLabel,
  fieldValue,
  gateNumber,
  measures,
  money,
  month,
  NONE,
  parseDollars,
  parsePercent,
  percent,
  percentInput,
  todayUtc,
  words,
} from './format';

describe('money', () => {
  it('formats integer cents as dollars', () => {
    expect(money(245_000)).toBe('$2,450.00');
    expect(money(5)).toBe('$0.05');
    expect(money(0)).toBe('$0.00');
    expect(money(-195_000)).toBe('-$1,950.00');
    expect(money(750_000_000, { whole: true })).toBe('$7,500,000');
  });

  it('shows a placeholder when there is no amount', () => {
    expect(money(null)).toBe(NONE);
    expect(money(undefined)).toBe(NONE);
  });
});

describe('percent', () => {
  it('formats basis points as a percentage', () => {
    expect(percent(250)).toBe('2.5%');
    expect(percent(150)).toBe('1.5%');
    expect(percent(125)).toBe('1.25%');
    expect(percent(10_000)).toBe('100%');
    expect(percent(0)).toBe('0%');
    expect(percent(9)).toBe('0.09%');
    expect(percent(-1500)).toBe('-15%');
  });

  it('rounds fractional basis points and handles nothing', () => {
    expect(percent(33.4)).toBe('0.33%');
    expect(percent(100.0001)).toBe('1%');
    expect(percent(null)).toBe(NONE);
  });
});

describe('dates', () => {
  it('formats a calendar date without shifting it', () => {
    expect(date('2026-11-07')).toBe('Nov 7, 2026');
    expect(date('2026-01-31')).toBe('Jan 31, 2026');
    expect(date('2026-12-01T23:59:59.000Z')).toBe('Dec 1, 2026');
    expect(date(null)).toBe(NONE);
    expect(date('soon')).toBe('soon');
    expect(date('2026-13-01')).toBe('2026-13-01');
  });

  it('formats a period and a timestamp in UTC', () => {
    expect(month('2026-11')).toBe('Nov 2026');
    expect(month(null)).toBe(NONE);
    expect(dateTime('2026-11-07T14:05:09.123Z')).toBe('Nov 7, 2026 14:05 UTC');
    expect(dateTime('2026-11-07T23:30:00-05:00')).toBe('Nov 8, 2026 04:30 UTC');
    expect(dateTime(null)).toBe(NONE);
    expect(dateTime('never')).toBe('never');
  });

  it('counts days in words', () => {
    expect(days(0)).toBe('today');
    expect(days(1)).toBe('1 day');
    expect(days(34)).toBe('34 days');
    expect(days(null)).toBe(NONE);
    const now = new Date('2026-11-11T09:00:00Z');
    expect(todayUtc(now)).toBe('2026-11-11');
    expect(age('2026-11-11T01:00:00Z', now)).toBe('today');
    expect(age('2026-11-10T23:00:00Z', now)).toBe('1 day ago');
    expect(age('2026-10-08T12:00:00Z', now)).toBe('34 days ago');
    expect(age(null, now)).toBe(NONE);
  });
});

describe('deadline', () => {
  const today = '2026-11-11';

  it('is quiet while there is time', () => {
    expect(deadline('2026-12-05', today)).toEqual({
      tone: 'neutral',
      label: 'Due in 24 days',
      daysLeft: 24,
    });
  });

  it('warns inside the last ten days', () => {
    expect(deadline('2026-11-21', today)).toMatchObject({ tone: 'warn', label: 'Due in 10 days' });
    expect(deadline('2026-11-22', today)).toMatchObject({ tone: 'neutral' });
    expect(deadline('2026-11-12', today)).toMatchObject({ tone: 'warn', label: 'Due in 1 day' });
  });

  it('is late on the due date and after it', () => {
    expect(deadline('2026-11-11', today)).toMatchObject({ tone: 'bad', label: 'Due today' });
    expect(deadline('2026-11-07', today)).toEqual({
      tone: 'bad',
      label: '4 days overdue',
      daysLeft: -4,
    });
    expect(deadline('2026-11-10', today)).toMatchObject({ label: '1 day overdue' });
  });

  it('has nothing to say before submission', () => {
    expect(deadline(null, today)).toBeNull();
  });
});

describe('words and labels', () => {
  it('turns codes into words', () => {
    expect(words('IN_REVIEW')).toBe('In review');
    expect(words('rent_plan')).toBe('Rent plan');
    expect(words('portfolio.first_payment_default')).toBe('Portfolio first payment default');
    expect(words('')).toBe(NONE);
    expect(words(null)).toBe(NONE);
  });

  it('labels detail keys and drops unit suffixes', () => {
    expect(fieldLabel('daysPastDue')).toBe('Days past due');
    expect(fieldLabel('rateBps')).toBe('Rate');
    expect(fieldLabel('owedCents')).toBe('Owed');
    expect(fieldLabel('businessId')).toBe('Business id');
    expect(fieldLabel('rentAffordability')).toBe('Rent affordability');
  });

  it('formats a detail value by what its key says', () => {
    expect(fieldValue('owedCents', 240_000)).toBe('$2,400.00');
    expect(fieldValue('rateBps', 1250)).toBe('12.5%');
    expect(fieldValue('plans', 1200)).toBe('1,200');
    expect(fieldValue('deadline', '2026-11-07')).toBe('Nov 7, 2026');
    expect(fieldValue('at', '2026-11-07T14:05:00.000Z')).toBe('Nov 7, 2026 14:05 UTC');
    expect(fieldValue('cohort', '2026-09')).toBe('Sep 2026');
    expect(fieldValue('ok', false)).toBe('No');
    expect(fieldValue('x', null)).toBe(NONE);
    expect(fieldValue('codes', ['R01', 'R02'])).toBe('R01, R02');
    expect(fieldValue('codes', [])).toBe('None');
    expect(
      fieldValue(
        'planIds',
        Array.from({ length: 10 }, (_, i) => `p${i}`),
      ),
    ).toBe('p0, p1, p2, p3, p4, p5, p6, p7 and 2 more');
    expect(fieldValue('buckets', { CURRENT: 1 })).toBe('{"CURRENT":1}');
    expect(detailRows({ owedCents: 100, status: 'OPEN' })).toEqual([
      { key: 'owedCents', label: 'Owed', value: '$1.00' },
      { key: 'status', label: 'Status', value: 'Open' },
    ]);
    // Codes read as words; names, country codes, and return codes do not change.
    expect(fieldValue('reason', 'PAST_DUE')).toBe('Past due');
    expect(fieldValue('kind', 'PERIODIC_REVIEW')).toBe('Periodic review');
    expect(fieldValue('country', 'US')).toBe('US');
    expect(fieldValue('returnCode', 'R01')).toBe('R01');
    expect(fieldValue('name', 'Blue Door Bakery LLC')).toBe('Blue Door Bakery LLC');
  });

  it('formats a policy value by its unit', () => {
    expect(byUnit(1_000_000, 'cents')).toBe('$10,000');
    expect(byUnit(2050, 'cents')).toBe('$20.50');
    expect(byUnit(8500, 'bps')).toBe('85%');
    expect(byUnit(3, 'days')).toBe('3 days');
    expect(byUnit(0, 'days')).toBe('0 days');
    expect(byUnit(1, 'months')).toBe('1 month');
    expect(byUnit(1.25, 'ratio')).toBe('1.25x');
    expect(byUnit(50, 'score')).toBe('50');
    expect(byUnit(true, 'flag')).toBe('Yes');
    expect(byUnit(null, 'days')).toBe('None');
    expect(byUnit('standard', 'text')).toBe('standard');
  });

  it('formats a gate value in its own unit', () => {
    expect(gateNumber(26_955_276, 'cents')).toBe('$269,552');
    expect(gateNumber(18, 'bps of volume')).toBe('18 bps (0.18%)');
    expect(gateNumber(4071, 'bps of applicants')).toBe('4,071 bps (40.71%)');
    expect(gateNumber(0.875, 'AUC')).toBe('0.875');
    expect(gateNumber(0, 'inversions')).toBe('0');
    expect(gateNumber(null, 'AUC')).toBe('Not measurable');
    expect(comparator('<=')).toBe('at most');
    expect(comparator('=')).toBe('exactly');
    expect(comparator('~')).toBe('~');
  });
});

describe('alerts', () => {
  it('sorts by severity, then oldest first', () => {
    const alerts = [
      { id: 'a', severity: 'INFO', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'b', severity: 'CRITICAL', createdAt: '2026-11-09T00:00:00Z' },
      { id: 'c', severity: 'HIGH', createdAt: '2026-11-02T00:00:00Z' },
      { id: 'd', severity: 'CRITICAL', createdAt: '2026-11-03T00:00:00Z' },
      { id: 'e', severity: 'WARNING', createdAt: '2026-11-04T00:00:00Z' },
    ] as const;
    expect(bySeverityThenAge(alerts).map((a) => a.id)).toEqual(['d', 'b', 'c', 'e', 'a']);
    // The input is left as it was.
    expect(alerts[0].id).toBe('a');
  });

  it('pairs a measured value with the threshold that raised the alert', () => {
    expect(measures({ shareBps: 4200, capBps: 4000, committedCents: 1 })).toEqual([
      { label: 'Share of pool capital', value: '42%', threshold: '40%', thresholdLabel: 'cap' },
    ]);
    expect(measures({ rateBps: 320, warnBps: 150, criticalBps: 300 })).toEqual([
      { label: 'Rate', value: '3.2%', threshold: '1.5%', thresholdLabel: 'warning at' },
      { label: 'Rate', value: '3.2%', threshold: '3%', thresholdLabel: 'critical at' },
    ]);
    expect(measures({ utilizationBps: 9100, ceilingBps: 8500 })).toEqual([
      { label: 'Pool utilization', value: '91%', threshold: '85%', thresholdLabel: 'ceiling' },
    ]);
    expect(measures({ daysWaiting: 34, deadline: '2026-11-07' })).toEqual([
      { label: 'Waiting', value: '34 days', threshold: 'Nov 7, 2026', thresholdLabel: 'deadline' },
    ]);
    expect(measures({ businessId: 'b1', utilizationBps: null, ceilingBps: 8500 })).toEqual([]);
  });
});

describe('form amounts', () => {
  it('parses dollars into integer cents', () => {
    expect(parseDollars('3600')).toBe(360_000);
    expect(parseDollars('$3,600.50')).toBe(360_050);
    expect(parseDollars('0.5')).toBe(50);
    expect(parseDollars(' 12 ')).toBe(1200);
    // No float drift: 1.15 * 100 is 114.99999999999999 in floating point.
    expect(parseDollars('1.15')).toBe(115);
    expect(parseDollars('1.155')).toBeNull();
    expect(parseDollars('-5')).toBeNull();
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('')).toBeNull();
  });

  it('parses a percentage into basis points', () => {
    expect(parsePercent('1.5')).toBe(150);
    expect(parsePercent('2.25%')).toBe(225);
    expect(parsePercent('4')).toBe(400);
    expect(parsePercent('0.07')).toBe(7);
    expect(parsePercent('1.255')).toBeNull();
    expect(parsePercent('')).toBeNull();
  });

  it('round trips the engine terms through the form fields', () => {
    expect(dollarsInput(360_000)).toBe('3600');
    expect(dollarsInput(360_050)).toBe('3600.50');
    expect(dollarsInput(null)).toBe('');
    expect(percentInput(150)).toBe('1.5');
    expect(percentInput(null)).toBe('');
    for (const cents of [360_000, 360_050, 1, 99, 1_000_000]) {
      expect(parseDollars(dollarsInput(cents))).toBe(cents);
    }
    for (const bps of [150, 225, 400, 5, 395]) {
      expect(parsePercent(percentInput(bps))).toBe(bps);
    }
  });
});
