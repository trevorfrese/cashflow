import { describe, expect, it } from 'vitest';

import {
  catalogEntry,
  FACTOR_CODES,
  findJargon,
  REASON_CATALOG,
  ReasonCode,
  reviewerReasonCodes,
} from './catalog';

describe('reason catalog', () => {
  it('has unique codes in the stable code shape', () => {
    const codes = REASON_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(ReasonCode.options).toEqual(codes);
  });

  it('writes every applicant text, guidance and measure in plain words', () => {
    for (const e of REASON_CATALOG) {
      const texts = [e.title, e.applicantText, e.guidance, 'measures' in e ? e.measures : ''];
      for (const text of texts) {
        expect(findJargon(text), `${e.code}: "${text}"`).toBeNull();
        expect(text).not.toMatch(/\u2014/);
      }
      expect(e.applicantText.length, e.code).toBeGreaterThan(20);
      expect(e.guidance.length, e.code).toBeGreaterThan(15);
      expect(e.applicantText.endsWith('.'), e.code).toBe(true);
      expect(e.guidance.endsWith('.'), e.code).toBe(true);
    }
  });

  it('catches the jargon it exists to catch', () => {
    for (const text of [
      'Score below cutoff.',
      'Knocked out by rule.',
      'Outside our credit policy.',
      'Fee of 250 bps.',
      'The rentToRevenueBps was too high.',
      'Flag ROUND_TRIP_DEPOSITS fired.',
      'Insufficient score.',
      'Does not meet internal standards.',
    ]) {
      expect(findJargon(text), text).not.toBeNull();
    }
    expect(
      findJargon('Average monthly deposits were $8,200, below the $12,000 needed.'),
    ).toBeNull();
  });

  it('never makes the overall score or a status line a principal reason', () => {
    expect(catalogEntry('SCORE_BELOW_MINIMUM')?.adverseActionEligible).toBe(false);
    for (const e of REASON_CATALOG.filter((x) => x.kind === 'STATUS')) {
      expect(e.adverseActionEligible, e.code).toBe(false);
    }
  });

  it('points every related factor at a factor in the catalog', () => {
    for (const e of REASON_CATALOG) {
      if (e.relatedFactor) expect(FACTOR_CODES, e.code).toContain(e.relatedFactor);
    }
    expect(FACTOR_CODES).toEqual([
      'RENT_TO_REVENUE',
      'CASH_FLOW_COVERAGE',
      'CASH_BUFFER',
      'ACCOUNT_CONDUCT',
      'REVENUE_STABILITY',
      'REVENUE_TREND',
      'DEBT_LOAD',
      'DATA_DEPTH',
      'PAYMENT_HISTORY',
    ]);
  });

  it('gives a reviewer only adverse action reasons to decline for and asks to request', () => {
    const decline = reviewerReasonCodes('DECLINE');
    const ask = reviewerReasonCodes('REQUEST_INFO');
    expect(decline.length).toBeGreaterThan(10);
    expect(ask.length).toBeGreaterThan(3);
    for (const code of decline) {
      const e = catalogEntry(code)!;
      expect(e.adverseActionEligible, code).toBe(true);
      expect(['DECLINE', 'FACTOR'], code).toContain(e.kind);
    }
    for (const code of ask) expect(catalogEntry(code)!.kind, code).toBe('NEEDS_INFO');
    expect(decline).not.toContain('SCORE_BELOW_MINIMUM');
  });
});
