import { describe, expect, it } from 'vitest';

import { heldPayoutNotice, IN_REVIEW_COPY, pastDueNotice } from './plan-notices';

const standing = (over: Partial<Parameters<typeof pastDueNotice>[0]> = {}) => ({
  delinquencyStatus: 'CURRENT' as const,
  daysPastDue: 0,
  pastDueCents: 0,
  needsPayment: false,
  ...over,
});

describe('pastDueNotice', () => {
  it('is silent on a current plan', () => {
    expect(pastDueNotice(standing())).toBeNull();
  });

  it('warns inside the grace period with the amount and age', () => {
    const n = pastDueNotice(
      standing({ delinquencyStatus: 'GRACE', daysPastDue: 1, pastDueCents: 155_000 }),
    );
    expect(n?.tone).toBe('warning');
    expect(n?.title).toBe('Payment past due');
    expect(n?.message).toContain('$1,550 is 1 day past due.');
    expect(n?.message).toContain('will be held');
  });

  it('is an error past grace and says payouts are on hold', () => {
    const n = pastDueNotice(
      standing({ delinquencyStatus: 'DELINQUENT', daysPastDue: 12, pastDueCents: 310_000 }),
    );
    expect(n?.tone).toBe('danger');
    expect(n?.message).toContain('$3,100 is 12 days past due.');
    expect(n?.message).toContain('on hold until it is paid');
  });

  it('asks for a manual payment when automatic debits have stopped', () => {
    const n = pastDueNotice(
      standing({
        delinquencyStatus: 'GRACE',
        daysPastDue: 2,
        pastDueCents: 100,
        needsPayment: true,
      }),
    );
    expect(n?.tone).toBe('danger');
    expect(n?.title).toBe('Payment needed');
    expect(n?.message).toContain('Automatic payments from your bank have stopped');
  });

  it('explains a charged off plan', () => {
    const n = pastDueNotice(standing({ delinquencyStatus: 'CHARGED_OFF', daysPastDue: 95 }));
    expect(n?.tone).toBe('danger');
    expect(n?.message).toContain('still owed');
  });

  it('states the unpaid balance of a charged off plan when it is known', () => {
    const n = pastDueNotice(
      standing({ delinquencyStatus: 'CHARGED_OFF', daysPastDue: 95, pastDueCents: 197925 }),
    );
    expect(n?.message).toContain('The unpaid balance of $1,979.25 is still owed');
  });
});

describe('heldPayoutNotice', () => {
  it('is silent when nothing is held', () => {
    expect(heldPayoutNotice(null)).toBeNull();
    expect(heldPayoutNotice(undefined)).toBeNull();
  });

  it('shows the API message and the release deadline', () => {
    const n = heldPayoutNotice({
      heldMessage: 'An earlier payment is past due.',
      releaseBy: '2026-12-06',
      periodMonth: '2026-12',
    });
    expect(n?.title).toBe('December 2026 rent payment on hold');
    expect(n?.message).toContain('An earlier payment is past due.');
    expect(n?.message).toContain('through Dec 6, 2026');
    expect(n?.message).toContain('pay your landlord directly for December 2026');
  });

  it('falls back to a plain line with no message or deadline', () => {
    const n = heldPayoutNotice({ heldMessage: null, releaseBy: null, periodMonth: '2026-12' });
    expect(n?.message).toBe('This rent payment is on hold.');
  });
});

describe('in review copy', () => {
  it('names the timing and never mentions terms', () => {
    expect(IN_REVIEW_COPY.message).toContain('30 days');
    expect(IN_REVIEW_COPY.message).not.toMatch(/\$|fee|limit/i);
  });
});
