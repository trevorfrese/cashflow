import { describe, expect, it } from 'vitest';

import {
  centsToDollarsInput,
  dollarsToCents,
  percentToBps,
  formatDate,
  monthsSince,
  normalizeMonthInput,
  ordinal,
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
