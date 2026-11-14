import { AdverseActionNoticeKind, FactorStatus, ReviewReasonCode } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { ApiError, query, toApiError } from './api';
import {
  breakerRule,
  dispositionLabel,
  freezeReason,
  holdReason,
  FACTOR_STATUS,
  integrityLabel,
  JOB_HEALTH,
  NOTICE_KINDS,
  reasonTitle,
  refusal,
  REVIEW_REASONS,
  SEVERITY,
  status,
  triggerLabel,
} from './labels';

describe('reasons and notices', () => {
  it('names every notice kind and factor status, and titles catalog reasons', () => {
    for (const kind of AdverseActionNoticeKind.options)
      expect(NOTICE_KINDS[kind], kind).toBeTruthy();
    for (const s of FactorStatus.options) expect(FACTOR_STATUS[s].label, s).toBeTruthy();
    expect(reasonTitle('CASH_BUFFER')).toBe('Cash buffer');
    expect(reasonTitle('NOT_IN_CATALOG')).toBe('Not in catalog');
  });
});

describe('plain words', () => {
  it('explains why an application was referred', () => {
    expect(triggerLabel('SCORE_NEAR_CUTOFF')).toBe(
      'The score passes, but only just above the cutoff',
    );
    expect(triggerLabel('INTEGRITY:DUPLICATE_BANK_ACCOUNT')).toBe(
      'Integrity flag: The same bank account is linked under another user',
    );
    expect(triggerLabel('CIRCUIT_BREAKER')).toContain('circuit breaker');
    expect(triggerLabel('SOMETHING_NEW')).toBe('Something new');
    expect(integrityLabel('NOT_LISTED_YET')).toBe('Not listed yet');
  });

  it('has a label for every review reason code', () => {
    for (const code of ReviewReasonCode.options) {
      expect(REVIEW_REASONS[code], code).toBeTruthy();
    }
  });

  it('explains holds, freezes, and dispositions, and falls back to the code in words', () => {
    expect(holdReason('PAST_DUE')).toBe('An earlier installment is past the grace period');
    expect(holdReason('SOME_NEW_HOLD')).toBe('Some new hold');
    expect(holdReason(null)).toBe('');
    expect(freezeReason('UNAUTHORIZED_RETURN')).toBe('A debit came back as unauthorized');
    expect(freezeReason(null)).toBe('Frozen');
    expect(freezeReason('OPERATOR_HOLD')).toBe('An admin froze it by hand');
    expect(freezeReason('SCORE_BELOW_WATCH')).toContain('below the watch level');
    expect(dispositionLabel('FALSE_POSITIVE')).toContain('False positive');
    expect(dispositionLabel(null)).toBe('');
  });

  it('says who tripped the breaker and how each job stands', () => {
    expect(breakerRule('manual')).toBe('An admin, by hand');
    expect(breakerRule('portfolio.fpd_rate')).toBe('Monitoring rule portfolio.fpd_rate');
    expect(breakerRule(null)).toBe('-');
    for (const health of ['OK', 'RUNNING', 'FAILED', 'LATE', 'NEVER_RAN']) {
      expect(JOB_HEALTH[health]?.label, health).toBeTruthy();
    }
    expect(JOB_HEALTH.LATE!.tone).toBe('bad');
  });

  it('explains the refusals of the controls and the reviewer ceiling', () => {
    for (const code of [
      'BREAKER_ALREADY_TRIPPED',
      'PLAN_ALREADY_FROZEN',
      'ADMIN_FREEZE',
      'NO_LIMIT_TO_LOWER',
      'NO_LIMIT_CAP',
    ]) {
      expect(refusal({ code, message: 'x' }).title, code).not.toBe('The API refused this');
    }
    expect(
      refusal({
        code: 'ABOVE_REVIEWER_AUTHORITY',
        message: 'A reviewer may approve up to $10,000.00',
      }).body,
    ).toContain('$10,000.00');
  });

  it('gives every severity a name and a distinct level, so it never relies on color', () => {
    const levels = Object.values(SEVERITY).map((s) => s.level);
    expect(new Set(levels).size).toBe(4);
    expect(SEVERITY.CRITICAL.level).toBeGreaterThan(SEVERITY.HIGH.level);
    expect(Object.values(SEVERITY).every((s) => s.label.length > 0)).toBe(true);
  });

  it('maps statuses to a label and a tone', () => {
    expect(status('PAID')).toEqual({ label: 'Paid', tone: 'good' });
    expect(status('HELD')).toEqual({ label: 'On hold', tone: 'warn' });
    expect(status('CHARGED_OFF')).toEqual({ label: 'Written off', tone: 'bad' });
    expect(status('POSSIBLE_MATCH')).toEqual({ label: 'Possible match', tone: 'warn' });
    expect(status('MATCH')).toEqual({ label: 'Match', tone: 'bad' });
    expect(status('SOMETHING_ELSE')).toEqual({ label: 'Something else', tone: 'neutral' });
    expect(status(null)).toEqual({ label: 'None', tone: 'neutral' });
  });
});

describe('API refusals', () => {
  it('turns the refusals a reviewer will meet into what to do next', () => {
    const hit = refusal({ code: 'SCREENING_HIT_OPEN', message: 'x' });
    expect(hit.href).toBe('/screening');
    expect(hit.body).toContain('screening queue');

    const identity = refusal({ code: 'IDENTITY_NOT_VERIFIED', message: 'x' });
    expect(identity.body).toContain(REVIEW_REASONS.IDENTITY_VERIFIED);

    expect(refusal({ code: 'REASON_CODES_REQUIRED', message: 'x' }).body).toContain('override');
    expect(refusal({ code: 'FORBIDDEN', message: 'x' }).title).toContain('admin');
    expect(refusal({ code: 'LEASE_CHANGE_PENDING', message: 'x' }).href).toBe('/lease-changes');
  });

  it('names the fields a validation error is about', () => {
    expect(
      refusal({
        code: 'VALIDATION_ERROR',
        message: 'Request failed validation',
        details: [{ path: '/notes', message: 'Too small: expected string to have >=3 characters' }],
      }).body,
    ).toBe('Notes: Too small: expected string to have >=3 characters.');
    expect(refusal({ code: 'VALIDATION_ERROR', message: 'x' }).body).toContain('required fields');
  });

  it('shows the API message for a code it does not know', () => {
    expect(refusal({ code: 'BRAND_NEW_CODE', message: 'Exactly what the API said' })).toEqual({
      title: 'The API refused this',
      body: 'Exactly what the API said',
    });
  });
});

describe('API client helpers', () => {
  it('reads an error body, and survives one that is not an error body', () => {
    const error = toApiError(422, {
      error: { code: 'SCREENING_HIT_OPEN', message: 'Clear it', details: { screeningIds: ['s1'] } },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'SCREENING_HIT_OPEN', message: 'Clear it' });
    expect(error.details).toEqual({ screeningIds: ['s1'] });
    expect(toApiError(500, null)).toMatchObject({ code: 'REQUEST_FAILED', status: 500 });
    expect(toApiError(502, '<html>')).toMatchObject({ code: 'REQUEST_FAILED' });
  });

  it('builds a query string and leaves empty filters out', () => {
    expect(
      query({ status: 'OPEN', severity: '', category: undefined, limit: 50, cursor: null }),
    ).toBe('?status=OPEN&limit=50');
    expect(query({ q: 'alder & ash' })).toBe('?q=alder+%26+ash');
    expect(query({})).toBe('');
  });
});
