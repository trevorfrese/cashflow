import { findJargon } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { APPLICATION_DISCLOSURE, longDate, NOTICE_KIND_LABEL } from './decision';

describe('decision copy', () => {
  it('discloses the data used and the right to specific reasons, in plain words', () => {
    const text = APPLICATION_DISCLOSURE.points.join(' ');
    expect(text).toMatch(/specific reasons/);
    expect(text).toMatch(/bank account/);
    for (const point of APPLICATION_DISCLOSURE.points) expect(findJargon(point)).toBeNull();
  });

  it('labels every notice kind and formats dates without a time zone shift', () => {
    expect(Object.keys(NOTICE_KIND_LABEL)).toHaveLength(4);
    expect(longDate('2026-11-12')).toBe('November 12, 2026');
    expect(longDate('2026-11-12T23:30:00.000Z')).toBe('November 12, 2026');
  });
});
