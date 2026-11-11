import { describe, expect, it } from 'vitest';

import {
  MOCK_LATE_RETURN_DAYS,
  MOCK_RETURN_DAYS,
  MockPaymentsProvider,
  parseReturnPlan,
} from './mock.ts';

const charge = (token: string, key: string, effectiveDate = '2026-03-01') => ({
  amountCents: 310_000,
  sourceToken: token,
  idempotencyKey: key,
  description: 'test',
  effectiveDate,
});

describe('mock payments provider', () => {
  it('reads return keywords from a token', () => {
    expect(parseReturnPlan('mock_acct_abc')).toBeNull();
    expect(parseReturnPlan('mock_acct_return_r01')).toEqual({
      returnCode: 'R01',
      afterDays: MOCK_RETURN_DAYS,
      once: false,
    });
    expect(parseReturnPlan('mock_acct_RETURN_R02_x')).toMatchObject({ returnCode: 'R02' });
    expect(parseReturnPlan('mock_acct_late_return_r10')).toEqual({
      returnCode: 'R10',
      afterDays: MOCK_LATE_RETURN_DAYS,
      once: false,
    });
    expect(parseReturnPlan('mock_acct_return_r01_once')).toMatchObject({ once: true });
  });

  it('succeeds by default, fails on "fail", and is idempotent by key', async () => {
    const p = new MockPaymentsProvider();
    const ok = await p.charge(charge('mock_acct_abc', 'k1'));
    expect(ok.ok).toBe(true);
    expect(await p.charge(charge('mock_acct_abc', 'k1'))).toBe(ok);
    const failed = await p.charge(charge('mock_acct_fail', 'k2'));
    expect(failed).toMatchObject({ ok: false, providerRef: null });
    expect(p.calls).toHaveLength(2);
    expect(await p.listReturns({ from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
  });

  it('accepts a payment and returns it two days later with the code in the token', async () => {
    const p = new MockPaymentsProvider();
    const res = await p.charge(charge('mock_acct_return_r01', 'k1', '2026-03-01'));
    expect(res.ok).toBe(true);
    // Nothing has come back on the day, or the day after.
    expect(await p.listReturns({ from: '2026-02-01', to: '2026-03-02' })).toEqual([]);
    const returns = await p.listReturns({ from: '2026-02-01', to: '2026-03-03' });
    expect(returns).toEqual([
      {
        providerRef: res.ok ? res.providerRef : '',
        kind: 'charge',
        amountCents: 310_000,
        returnCode: 'R01',
        reason: 'Insufficient funds',
        returnedOn: '2026-03-03',
      },
    ]);
    // Polling again gives the same answer: the caller remembers what it handled.
    expect(await p.listReturns({ from: '2026-02-01', to: '2026-03-03' })).toEqual(returns);
    // And the window is honored at both ends.
    expect(await p.listReturns({ from: '2026-03-04', to: '2026-04-01' })).toEqual([]);
  });

  it('returns an unauthorized debit weeks later, and a payout to a bad account', async () => {
    const p = new MockPaymentsProvider();
    await p.charge(charge('mock_acct_late_return_r10', 'k1', '2026-03-01'));
    await p.payout({
      amountCents: 620_000,
      destinationToken: 'mock_landlord_return_r03',
      idempotencyKey: 'p1',
      description: 'rent',
      effectiveDate: '2026-03-01',
    });
    expect(
      (await p.listReturns({ from: '2026-03-01', to: '2026-03-21' })).map((r) => r.returnCode),
    ).toEqual(['R03']);
    const all = await p.listReturns({ from: '2026-03-01', to: '2026-03-22' });
    expect(all.map((r) => [r.kind, r.returnCode, r.returnedOn])).toEqual([
      ['payout', 'R03', '2026-03-03'],
      ['charge', 'R10', '2026-03-22'],
    ]);
  });

  it('returns only the first payment on a "_once" token', async () => {
    const p = new MockPaymentsProvider();
    await p.charge(charge('mock_acct_return_r01_once', 'k1', '2026-03-01'));
    await p.charge(charge('mock_acct_return_r01_once', 'k2', '2026-03-04'));
    expect(await p.listReturns({ from: '2026-03-01', to: '2026-12-31' })).toHaveLength(1);
  });

  it('lets a test return any accepted payment', async () => {
    const p = new MockPaymentsProvider();
    const res = await p.charge(charge('mock_acct_abc', 'k1'));
    if (!res.ok) throw new Error('expected success');
    p.scheduleReturn(res.providerRef, 'R02', '2026-03-09');
    expect(await p.listReturns({ from: '2026-03-09', to: '2026-03-09' })).toMatchObject([
      { providerRef: res.providerRef, returnCode: 'R02', reason: 'Account closed' },
    ]);
    expect(() => p.scheduleReturn('nope', 'R02', '2026-03-09')).toThrow(/Unknown mock payment/);
  });
});
