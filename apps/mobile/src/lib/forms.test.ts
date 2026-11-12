import { describe, expect, it } from 'vitest';

import {
  centsToDollarsInput,
  fieldError,
  dollarsToCents,
  percentToBps,
  formatDate,
  formatMoney,
  monthsSince,
  normalizeMonthInput,
  ordinal,
  plural,
  upcomingMonthStarts,
} from './forms';

describe('dollarsToCents', () => {
  it('parses plain and formatted amounts', () => {
    expect(dollarsToCents('2450')).toBe(245000);
    expect(dollarsToCents('$2,450.50')).toBe(245050);
    expect(dollarsToCents('0.5')).toBe(50);
    expect(dollarsToCents(' 12 ')).toBe(1200);
  });

  it('rejects junk', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
  });

  it('round trips with centsToDollarsInput', () => {
    expect(centsToDollarsInput(245000)).toBe('2450');
    expect(centsToDollarsInput(245005)).toBe('2450.05');
    expect(dollarsToCents(centsToDollarsInput(999999))).toBe(999999);
  });
});

describe('normalizeMonthInput', () => {
  it('accepts a month or a full date', () => {
    expect(normalizeMonthInput('2021-03')).toBe('2021-03-01');
    expect(normalizeMonthInput('2021-3')).toBe('2021-03-01');
    expect(normalizeMonthInput('2021-03-15')).toBe('2021-03-15');
  });

  it('rejects invalid values', () => {
    expect(normalizeMonthInput('2021')).toBeNull();
    expect(normalizeMonthInput('2021-13')).toBeNull();
    expect(normalizeMonthInput('2021-02-30')).toBeNull();
  });
});

describe('dates', () => {
  it('counts whole months since a date', () => {
    const now = new Date(Date.UTC(2026, 10, 9));
    expect(monthsSince('2024-11-01', now)).toBe(24);
    expect(monthsSince('2026-12-01', now)).toBe(0);
  });

  it('formats dates and ordinals', () => {
    expect(formatDate('2026-11-16')).toBe('Nov 16, 2026');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
  });
});

describe('percentToBps', () => {
  it('turns a whole percentage into basis points', () => {
    expect(percentToBps('100')).toBe(10_000);
    expect(percentToBps('25%')).toBe(2500);
    expect(percentToBps(' 1 ')).toBe(100);
  });

  it('rejects zero, more than 100, and anything that is not a whole number', () => {
    expect(percentToBps('0')).toBeNull();
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('12.5')).toBeNull();
    expect(percentToBps('')).toBeNull();
  });
});

describe('formatMoney', () => {
  it('shows whole dollars without cents', () => {
    expect(formatMoney(480000)).toBe('$4,800');
    expect(formatMoney(0)).toBe('$0');
  });
  it('keeps the cents when there are any, so nothing owed is rounded away', () => {
    expect(formatMoney(5850)).toBe('$58.50');
    expect(formatMoney(197925)).toBe('$1,979.25');
    expect(formatMoney(-265512)).toBe('-$2,655.12');
  });
});

describe('plural', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(0, 'day')).toBe('0 days');
    expect(plural(3, 'business', 'businesses')).toBe('3 businesses');
  });
});

describe('fieldError', () => {
  it("replaces the validator's own wording with plain words", () => {
    expect(
      fieldError({
        code: 'too_small',
        path: ['landlordName'],
        minimum: 1,
        message: 'Too small: expected string to have >=1 characters',
      }),
    ).toBe('Enter the landlord or property manager.');
    expect(
      fieldError({
        code: 'invalid_format',
        format: 'email',
        path: ['landlordEmail'],
        message: 'Invalid email address',
      }),
    ).toBe('Enter an email address, like name@example.com.');
    expect(
      fieldError({
        code: 'too_small',
        path: ['address', 'state'],
        minimum: 2,
        message: 'Too small: expected string to have >=2 characters',
      }),
    ).toBe('Use the two letter state code, like OR.');
    expect(
      fieldError({
        code: 'too_small',
        path: ['password'],
        minimum: 10,
        message: 'Too small: expected string to have >=10 characters',
      }),
    ).toBe('Use at least 10 characters.');
  });

  it('keeps a message the schema wrote for people', () => {
    expect(
      fieldError({
        code: 'invalid_format',
        path: ['taxIdLast4'],
        message: 'Enter the last 4 digits',
      }),
    ).toBe('Enter the last 4 digits');
  });
});

describe('upcomingMonthStarts', () => {
  it('starts next month and rolls over the year', () => {
    expect(upcomingMonthStarts('2026-11-12')).toEqual(['2026-12-01', '2027-01-01', '2027-02-01']);
    expect(upcomingMonthStarts('2026-12-31', 2)).toEqual(['2027-01-01', '2027-02-01']);
  });
});
