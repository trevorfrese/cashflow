import { describe, expect, it } from 'vitest';

import { canonicalJson, contentHash, recordCounts, verifySnapshot } from './snapshots.ts';

describe('snapshot hashing', () => {
  it('is independent of key order and stable', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('detects an altered payload', () => {
    const payload = { transactions: [{ id: 't1', amountCents: 100 }], currentBalanceCents: 5 };
    const stored = { payload, contentHash: contentHash(payload) };
    expect(verifySnapshot(stored)).toBe(true);
    expect(verifySnapshot({ ...stored, payload: { ...payload, currentBalanceCents: 6 } })).toBe(
      false,
    );
  });

  it('counts records by kind', () => {
    expect(recordCounts({ transactions: [], currentBalanceCents: null })).toEqual({
      transactions: 0,
    });
    expect(recordCounts({ dailySales: [], payouts: [] })).toEqual({ days: 0, payouts: 0 });
  });
});
