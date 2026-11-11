import type { BankTransaction } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { account, tx } from '../underwriting/test-support.ts';
import { assessVeracity, depthCredit } from './assess.ts';
import { VERACITY_RULES } from './rules.ts';
import {
  AS_OF,
  POLICY,
  applicant,
  bank,
  bankPull,
  commercePull,
  input,
  payoutsFor,
  pos,
  salesFor,
  variedAccount,
} from './test-support.ts';
import type { VeracityInput } from './types.ts';

const codes = (i: VeracityInput) => assessVeracity(i, POLICY).findings.map((f) => f.code);
const TXS = variedAccount();
const clean = () =>
  input({
    banks: [bank({ current: bankPull(TXS) })],
    commerce: [pos({ current: commercePull({}, TXS) })],
  });

describe('a clean application', () => {
  it('raises nothing, and both sources are independently verified at HIGH', () => {
    const a = assessVeracity(clean(), POLICY);
    expect(a.findings).toEqual([]);
    expect(a.overall).toEqual({
      outcome: 'CLEAR',
      trustTier: 'HIGH',
      independentlyVerifiedSources: 2,
    });
    expect(a.snapshots.map((s) => s.kind)).toEqual(['BANK', 'COMMERCE']);
    expect(a.reconciliation[0]!.matchedShareByAmountBps).toBe(10_000);
    expect(depthCredit(a, POLICY)).toMatchObject({ bankMultiplier: 1, verifiedSecondSource: true });
  });

  it('every rule has a check, a consequence and a reason', () => {
    for (const [code, rule] of Object.entries(VERACITY_RULES)) {
      expect(rule.why.length, code).toBeGreaterThan(30);
      if (rule.consequence === 'KNOCKOUT' || rule.consequence === 'NEEDS_INFO') {
        expect(rule.customerMessage, code).not.toBeNull();
      }
      expect(rule.customerMessage ?? '').not.toMatch(/fraud|suspicious|fake|fabricat/i);
    }
  });
});

describe('ownership', () => {
  it('fires on a bank holder that is neither the business nor an owner', () => {
    const i = clean();
    expect(
      codes({ ...i, banks: [{ ...i.banks[0]!, ownerNames: ['Harlow Ventures LLC'] }] }),
    ).toContain('BANK_OWNER_MISMATCH');
  });

  it('does not fire on a trading name, an owner, or no names at all', () => {
    const i = clean();
    for (const ownerNames of [['BLUE DOOR BAKERY'], ['Dana Rivera'], []]) {
      expect(codes({ ...i, banks: [{ ...i.banks[0]!, ownerNames }] })).toEqual([]);
    }
  });

  it('informs on a personal account in an owner name', () => {
    const i = clean();
    const f = assessVeracity(
      { ...i, banks: [{ ...i.banks[0]!, ownerNames: ['Dana Rivera'], accountType: 'PERSONAL' }] },
      POLICY,
    ).findings;
    expect(f.map((x) => [x.code, x.consequence])).toEqual([['PERSONAL_ACCOUNT', 'INFORM']]);
  });

  it('refers a platform name or tax id that does not match, and excludes the platform', () => {
    const i = clean();
    const a = assessVeracity(
      { ...i, commerce: [{ ...i.commerce[0]!, legalName: 'Harlow Ventures LLC' }] },
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['PLATFORM_NAME_MISMATCH']);
    expect(a.sources.find((s) => s.kind === 'COMMERCE')!.usableForRevenue).toBe(false);
    expect(codes({ ...i, commerce: [{ ...i.commerce[0]!, taxIdLast4: '9999' }] })).toEqual([
      'PLATFORM_TAX_ID_MISMATCH',
    ]);
    expect(codes({ ...i, commerce: [{ ...i.commerce[0]!, legalName: 'Dana Rivera' }] })).toEqual(
      [],
    );
    expect(
      codes({ ...i, commerce: [{ ...i.commerce[0]!, legalName: null, taxIdLast4: null }] }),
    ).toEqual([]);
  });

  it('knocks out when both sources name another business', () => {
    const i = clean();
    const both = codes({
      ...i,
      banks: [{ ...i.banks[0]!, ownerNames: ['Harlow Ventures LLC'] }],
      commerce: [{ ...i.commerce[0]!, legalName: 'Harlow Ventures LLC' }],
    });
    expect(both).toContain('BOTH_SOURCES_OTHER_BUSINESS');
  });
});

describe('payout destination', () => {
  it('asks the owner to connect the account sales are paid into', () => {
    const i = clean();
    const elsewhere = pos({
      payoutDestinations: [{ institutionName: 'Harbor Credit Union', mask: '0731', ref: null }],
      current: commercePull({ payouts: payoutsFor(TXS, '0731') }, TXS),
    });
    const a = assessVeracity({ ...i, commerce: [elsewhere] }, POLICY);
    const f = a.findings.find((x) => x.code === 'PAYOUT_ACCOUNT_NOT_CONNECTED')!;
    expect(f.consequence).toBe('NEEDS_INFO');
    expect(f.customerAction).toBe('CONNECT_PAYOUT_ACCOUNT');
    expect(a.overall.outcome).toBe('NEEDS_INFO');
  });

  it('does not fire when the payout account is a second connected account', () => {
    const i = clean();
    const second = bank({
      connectionId: 'bank_2',
      primary: false,
      accountMask: '0731',
      current: bankPull([]),
    });
    const elsewhere = pos({
      payoutDestinations: [{ institutionName: 'Harbor Credit Union', mask: '0731', ref: null }],
      current: commercePull({ payouts: payoutsFor(TXS, '0731') }, TXS),
    });
    expect(codes({ ...i, banks: [...i.banks, second], commerce: [elsewhere] })).toEqual([]);
  });

  it('refers payouts split between the connected account and an unseen one', () => {
    const i = clean();
    const payouts = [
      ...payoutsFor(TXS),
      ...payoutsFor(TXS, '0731').map((p) => ({
        ...p,
        id: `x${p.id}`,
        amountCents: Math.round(p.amountCents / 2),
      })),
    ];
    const sales = salesFor(TXS).map((d) => ({ ...d, grossCents: Math.round(d.grossCents * 1.5) }));
    expect(
      codes({
        ...i,
        commerce: [pos({ current: commercePull({ payouts, dailySales: sales }, TXS) })],
      }),
    ).toContain('PAYOUTS_PARTLY_TO_UNSEEN_ACCOUNT');
  });
});

describe('settlement reconciliation', () => {
  it('refers payouts that never reached the connected account', () => {
    const i = clean();
    const payouts = payoutsFor(TXS).map((p, k) =>
      k % 2 ? p : { ...p, amountCents: p.amountCents * 4 },
    );
    expect(codes({ ...i, commerce: [pos({ current: commercePull({ payouts }, TXS) })] })).toContain(
      'SETTLEMENT_UNMATCHED',
    );
  });

  it('only excludes the platform when matching is merely weak', () => {
    const i = clean();
    const payouts = payoutsFor(TXS).map((p, k) =>
      k % 4 ? p : { ...p, amountCents: p.amountCents * 2 },
    );
    const a = assessVeracity(
      { ...i, commerce: [pos({ current: commercePull({ payouts }, TXS) })] },
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['SETTLEMENT_LOW_MATCH']);
    expect(a.overall.outcome).toBe('EXCLUDE_SOURCE');
  });

  it('refers deposits that name the platform and match no payout', () => {
    const i = clean();
    const claiming = TXS.map((t) =>
      t.category === 'CARD_SETTLEMENT' ? { ...t, description: 'SQUARE INC SETTLEMENT' } : t,
    );
    const payouts = payoutsFor(TXS).filter((_, k) => k % 3 !== 0);
    expect(
      codes({
        ...i,
        banks: [bank({ current: bankPull(claiming) })],
        commerce: [pos({ current: commercePull({ payouts }, TXS) })],
      }),
    ).toContain('DEPOSITS_WITHOUT_PAYOUT');
  });

  it('refers card sales that are never paid out', () => {
    const i = clean();
    const sales = salesFor(TXS).map((d) => ({ ...d, grossCents: d.grossCents * 2 }));
    expect(
      codes({ ...i, commerce: [pos({ current: commercePull({ dailySales: sales }, TXS) })] }),
    ).toEqual(['SALES_NOT_PAID_OUT']);
  });

  it('without payout data, falls back to sales against card deposits', () => {
    const i = clean();
    const sales = salesFor(TXS).map((d) => ({ ...d, grossCents: d.grossCents * 2 }));
    expect(
      codes({
        ...i,
        commerce: [pos({ current: commercePull({ payouts: [], dailySales: sales }, TXS) })],
      }),
    ).toEqual(['POS_REVENUE_NOT_IN_BANK']);
    expect(
      codes({ ...i, commerce: [pos({ current: commercePull({ payouts: [] }, TXS) })] }),
    ).toEqual([]);
  });
});

describe('completeness', () => {
  const withTransfers = (share: number): BankTransaction[] => {
    const out = [...TXS];
    for (let d = 0; d < 90; d += 7)
      out.push(tx(addDays(AS_OF, -d), -Math.round(100_000 * 7 * share), 'TRANSFER_OUT'));
    return out;
  };

  it('refers sustained, material transfers to accounts that are not connected', () => {
    expect(
      codes(input({ banks: [bank({ current: bankPull(withTransfers(0.15)) })], commerce: [] })),
    ).toContain('TRANSFERS_TO_UNSEEN_ACCOUNTS');
  });

  it('does not fire on small transfers, or transfers to a connected account', () => {
    expect(
      codes(input({ banks: [bank({ current: bankPull(withTransfers(0.05)) })], commerce: [] })),
    ).toEqual([]);
    const toLinked = withTransfers(0.15).map((t) =>
      t.category === 'TRANSFER_OUT' ? { ...t, description: 'TRANSFER TO CHK 4821' } : t,
    );
    expect(codes(input({ banks: [bank({ current: bankPull(toLinked) })], commerce: [] }))).toEqual(
      [],
    );
  });

  it('informs on accounts visible on the login and not shared', () => {
    const visible = [
      { mask: '4821', name: 'Business Checking', type: 'BUSINESS' as const, shared: true },
      { mask: '7777', name: 'Business Savings', type: 'BUSINESS' as const, shared: false },
    ];
    expect(
      codes(
        input({
          banks: [bank({ current: bankPull(TXS), visibleAccounts: visible })],
          commerce: [],
        }),
      ),
    ).toEqual(['UNSHARED_ACCOUNTS']);
  });
});

describe('consistency', () => {
  const earlier = addDays(AS_OF, -20);
  const before = variedAccount(earlier);
  const after = [...before, ...variedAccount(AS_OF, 20)];

  it('knocks out final debits that disappeared between pulls', () => {
    const rewritten = after.filter(
      (t) =>
        !(
          t.category === 'SUPPLIER' &&
          t.date < addDays(earlier, -30) &&
          t.date > addDays(earlier, -45)
        ),
    );
    const a = assessVeracity(
      input({
        banks: [bank({ current: bankPull(rewritten), prior: [bankPull(before, earlier)] })],
        commerce: [],
      }),
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['HISTORY_REWRITTEN']);
    expect(a.overall.outcome).toBe('KNOCKOUT');
  });

  it('refers material changes that do not flatter, and informs on minor ones', () => {
    const extraDebits = [...after];
    for (let d = 40; d < 46; d++) extraDebits.push(tx(addDays(earlier, -d), -50_000, 'SUPPLIER'));
    expect(
      codes(
        input({
          banks: [bank({ current: bankPull(extraDebits), prior: [bankPull(before, earlier)] })],
          commerce: [],
        }),
      ),
    ).toEqual(['HISTORY_CHANGED']);
    const one = [...after, tx(addDays(earlier, -40), -50_000, 'SUPPLIER')];
    expect(
      codes(
        input({
          banks: [bank({ current: bankPull(one), prior: [bankPull(before, earlier)] })],
          commerce: [],
        }),
      ),
    ).toEqual(['HISTORY_MINOR_CHANGES']);
  });

  it('does not fire when only new days were added', () => {
    expect(
      codes(
        input({
          banks: [bank({ current: bankPull(after), prior: [bankPull(before, earlier)] })],
          commerce: [],
        }),
      ),
    ).toEqual([]);
  });

  it('refers platform sales that changed for final days', () => {
    const i = clean();
    const priorSales = salesFor(TXS).filter((d) => d.date <= earlier);
    const changed = salesFor(TXS).map((d) =>
      d.date < addDays(earlier, -30) ? { ...d, grossCents: d.grossCents + 5_000 } : d,
    );
    const p = pos({
      current: commercePull({ dailySales: changed }, TXS),
      prior: [
        {
          ...commercePull({ dailySales: priorSales }, TXS),
          pulledOn: earlier,
          windowTo: earlier,
          windowFrom: addDays(earlier, -399),
        },
      ],
    });
    expect(codes({ ...i, commerce: [p] })).toContain('SALES_HISTORY_CHANGED');
  });
});

describe('account age and continuity', () => {
  it('informs on a recently opened bank account at an established business, not a young one', () => {
    expect(
      codes(
        input({
          banks: [bank({ current: bankPull(TXS), openedOn: addDays(AS_OF, -90) })],
          commerce: [],
        }),
      ),
    ).toEqual(['BANK_ACCOUNT_RECENT']);
    expect(
      codes(
        input({
          applicant: applicant({ timeInBusinessMonths: 10 }),
          banks: [bank({ current: bankPull(TXS), openedOn: addDays(AS_OF, -90) })],
          commerce: [],
        }),
      ),
    ).toEqual([]);
  });

  it('reduces depth credit for a young platform account and refers one that came with a surge', () => {
    const i = clean();
    const young = addDays(AS_OF, -60);
    const a = assessVeracity(
      { ...i, commerce: [{ ...i.commerce[0]!, accountCreatedOn: young }] },
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['PLATFORM_ACCOUNT_RECENT']);
    expect(depthCredit(a, POLICY).verifiedSecondSource).toBe(false);
    const surge = account({ dailySalesCents: (d) => (d < 60 ? 200_000 : 100_000) });
    const s = codes({
      ...i,
      banks: [bank({ current: bankPull(surge) })],
      commerce: [pos({ accountCreatedOn: young, current: commercePull({}, surge) })],
    });
    expect(s).toContain('PLATFORM_NEW_WITH_SURGE');
  });

  it('informs on a gap of two weeks or more', () => {
    const gappy = TXS.filter(
      (t) => !(t.date > addDays(AS_OF, -120) && t.date < addDays(AS_OF, -100)),
    );
    expect(codes(input({ banks: [bank({ current: bankPull(gappy) })], commerce: [] }))).toEqual([
      'DATA_GAP',
    ]);
  });
});

describe('freshness', () => {
  it('asks the owner to reconnect a bank that could not be pulled, or is stale', () => {
    expect(
      codes(
        input({ banks: [bank({ current: null, pullError: 'ITEM_LOGIN_REQUIRED' })], commerce: [] }),
      ),
    ).toEqual(['BANK_DATA_UNAVAILABLE']);
    expect(
      codes(input({ banks: [bank({ current: bankPull(TXS, addDays(AS_OF, -3)) })], commerce: [] })),
    ).toEqual(['BANK_DATA_UNAVAILABLE']);
    const old = TXS.filter((t) => t.date < addDays(AS_OF, -10));
    expect(codes(input({ banks: [bank({ current: bankPull(old) })], commerce: [] }))).toEqual([
      'BANK_DATA_UNAVAILABLE',
    ]);
  });

  it('drops a platform that could not be pulled instead of using stale data', () => {
    const i = clean();
    const a = assessVeracity(
      { ...i, commerce: [pos({ current: null, pullError: 'token expired' })] },
      POLICY,
    );
    expect(a.findings.map((f) => [f.code, f.consequence])).toEqual([
      ['PLATFORM_DATA_UNAVAILABLE', 'EXCLUDE_SOURCE'],
    ]);
    expect(a.sources.find((s) => s.kind === 'COMMERCE')!.trustTier).toBe('NONE');
  });
});

describe('method strength', () => {
  it('a legacy bank connection is MEDIUM and earns three quarters of the depth credit', () => {
    const a = assessVeracity(
      input({
        banks: [bank({ current: bankPull(TXS), institutionAuthorized: false })],
        commerce: [],
      }),
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['LEGACY_BANK_CONNECTION']);
    expect(a.sources[0]!.trustTier).toBe('MEDIUM');
    expect(depthCredit(a, POLICY).bankMultiplier).toBe(0.75);
  });

  it('a delegated seat is MEDIUM and still verifies when it reconciles', () => {
    const i = clean();
    const a = assessVeracity(
      {
        ...i,
        commerce: [{ ...i.commerce[0]!, platform: 'TOAST', accessMethod: 'DELEGATED_SEAT' }],
      },
      POLICY,
    );
    expect(a.findings.map((f) => f.code)).toEqual(['DELEGATED_SEAT_SOURCE']);
    const seat = a.sources.find((s) => s.kind === 'COMMERCE')!;
    expect(seat.trustTier).toBe('MEDIUM');
    expect(seat.independentlyVerified).toBe(true);
  });
});
