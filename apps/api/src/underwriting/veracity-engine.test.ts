import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import {
  bank,
  bankPull,
  commercePull,
  input as veracityInput,
  payoutsFor,
  pos,
  salesFor,
  variedAccount,
} from '../veracity/test-support.ts';
import type { VeracityInput } from '../veracity/types.ts';
import { decide, type EngineInput } from './engine.ts';
import { POLICY_V2, POLICY_V3 } from './policy.ts';
import { AS_OF, engineInput } from './test-support.ts';

const TXS = variedAccount();
const withVeracity = (v: VeracityInput, over: Partial<EngineInput> = {}): EngineInput =>
  engineInput(TXS, {
    commerceData: {
      platform: 'SQUARE',
      dailySales: v.commerce[0]?.current?.dailySales.slice() ?? salesFor(TXS),
      connectedSince: '2020-01-01',
    },
    veracity: v,
    ...over,
  });
const clean = () =>
  veracityInput({
    banks: [bank({ current: bankPull(TXS) })],
    commerce: [pos({ current: commercePull({}, TXS) })],
  });

describe('the engine with veracity facts', () => {
  it('approves a clean application, stores the assessment, and credits the verified second source', () => {
    const r = decide(withVeracity(clean()));
    expect(r.outcome).toBe('APPROVED');
    expect(r.snapshot.veracity!.overall.outcome).toBe('CLEAR');
    expect(r.snapshot.veracity!.snapshots.map((s) => s.contentHash)).toEqual([
      `hash_${AS_OF}`,
      `poshash_${AS_OF}`,
    ]);
    expect(r.reasons.find((x) => x.code === 'DATA_DEPTH')!.message).toContain(
      'match your bank deposits',
    );
  });

  it('asks for the payout account, in words the owner can act on', () => {
    const v = clean();
    const elsewhere = pos({
      payoutDestinations: [{ institutionName: 'Harbor Credit Union', mask: '0731', ref: null }],
      current: commercePull({ payouts: payoutsFor(TXS, '0731') }, TXS),
    });
    const r = decide(withVeracity({ ...v, commerce: [elsewhere] }));
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons).toEqual([
      {
        code: 'PAYOUT_ACCOUNT_NOT_CONNECTED',
        message:
          'We could not match the bank account your sales are paid into with a connected account. Connect that account to continue.',
        impact: 'INFO',
      },
    ]);
    // A periodic review is scored anyway, and the owner is still prompted.
    const review = decide(withVeracity({ ...v, commerce: [elsewhere] }, { periodicReview: true }));
    expect(review.score).not.toBeNull();
    expect(review.snapshot.veracity!.findings.map((f) => f.code)).toContain(
      'PAYOUT_ACCOUNT_NOT_CONNECTED',
    );
  });

  it('declines rewritten history without saying why in rule terms', () => {
    const earlier = addDays(AS_OF, -20);
    const before = variedAccount(earlier);
    const after = [...before, ...variedAccount(AS_OF, 20)].filter(
      (t) =>
        !(
          t.category === 'SUPPLIER' &&
          t.date < addDays(earlier, -30) &&
          t.date > addDays(earlier, -45)
        ),
    );
    const v = veracityInput({
      banks: [bank({ current: bankPull(after), prior: [bankPull(before, earlier)] })],
      commerce: [],
    });
    const r = decide(engineInput(after, { veracity: v }));
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('ACCOUNT_HISTORY_NOT_VERIFIED');
    expect(r.reasons[0]!.message).not.toMatch(/rewrit|fraud|tamper/i);
  });

  it('refers a platform in another name and verifies revenue from the bank instead', () => {
    const v = clean();
    const sales = salesFor(TXS).map((d) => ({
      ...d,
      grossCents: d.grossCents * 2,
      cardShareBps: 4250,
    }));
    const other = pos({
      legalName: 'Harlow Ventures LLC',
      current: commercePull({ dailySales: sales }, TXS),
    });
    const r = decide(withVeracity({ ...v, commerce: [other] }));
    expect(r.outcome).toBe('REFER');
    expect(r.snapshot.referTriggers).toContain('VERACITY:PLATFORM_NAME_MISMATCH');
    // Platform sales are twice the bank's: had they been used, verified revenue would double.
    const bankOnly = decide(engineInput(TXS));
    expect(r.cashFlow!.verifiedMonthlyRevenueCents).toBe(
      bankOnly.cashFlow!.verifiedMonthlyRevenueCents,
    );
  });

  it('gives a legacy bank connection less data depth credit', () => {
    const v = veracityInput({
      banks: [bank({ current: bankPull(TXS), institutionAuthorized: false })],
      commerce: [],
    });
    const legacy = decide(engineInput(TXS, { veracity: v }));
    const oauth = decide(
      engineInput(TXS, {
        veracity: { ...v, banks: [{ ...v.banks[0]!, institutionAuthorized: true }] },
      }),
    );
    expect(oauth.score! - legacy.score!).toBe(1);
  });

  it('is ignored by a policy without veracity', () => {
    const v = clean();
    const r = decide(
      withVeracity({
        ...v,
        commerce: [pos({ legalName: 'Harlow Ventures LLC', current: commercePull({}, TXS) })],
      }),
      POLICY_V2,
    );
    expect(r.snapshot.veracity).toBeNull();
    expect(r.outcome).toBe('APPROVED');
    expect(decide(engineInput(TXS), POLICY_V3).snapshot.veracity).toBeNull();
  });
});
