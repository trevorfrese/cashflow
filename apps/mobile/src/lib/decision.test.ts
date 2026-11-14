import { AdverseActionNoticeKind, findJargon } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { APPLICATION_DISCLOSURE, longDate, needsInfoStep, NOTICE_KIND_LABEL } from './decision';

describe('decision copy', () => {
  it('discloses the data used and the right to specific reasons, in plain words', () => {
    const text = APPLICATION_DISCLOSURE.points.join(' ');
    expect(text).toMatch(/specific reasons/);
    expect(text).toMatch(/bank account/);
    for (const point of APPLICATION_DISCLOSURE.points) expect(findJargon(point)).toBeNull();
  });

  it('labels every notice kind and formats dates without a time zone shift', () => {
    expect(Object.keys(NOTICE_KIND_LABEL).sort()).toEqual(
      [...AdverseActionNoticeKind.options].sort(),
    );
    expect(longDate('2026-11-12')).toBe('November 12, 2026');
    expect(longDate('2026-11-12T23:30:00.000Z')).toBe('November 12, 2026');
  });
});

describe('needsInfoStep', () => {
  it('asks for a bank account when none is linked or one is missing', () => {
    expect(needsInfoStep([], false)).toBe('CONNECT_BANK');
    expect(needsInfoStep(['PAYOUT_ACCOUNT_NOT_CONNECTED'], true)).toBe('CONNECT_BANK');
  });
  it('sends a connection problem to the connections screen', () => {
    expect(needsInfoStep(['RECONNECT_REQUIRED'], true)).toBe('CONNECTIONS');
  });
  it('runs the decision again when nothing is left to connect', () => {
    expect(needsInfoStep(['BUSINESS_DETAILS_NEEDED'], true)).toBe('RUN_AGAIN');
  });
});
