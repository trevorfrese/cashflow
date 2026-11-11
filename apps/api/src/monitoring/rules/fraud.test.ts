import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type {
  ApplicationFact,
  BankAccountFact,
  LandlordAccountFact,
  LeaseChangeFact,
  ScreeningFact,
} from '../types.ts';
import {
  applicationVelocity,
  landlordChangeBeforePayout,
  landlordChangePending,
  landlordIsBorrowerAccount,
  reapplyAfterDecline,
  screeningHit,
  sharedBankAccount,
  sharedLandlordAccount,
} from './fraud.ts';

const change = (over: Partial<LeaseChangeFact> = {}): LeaseChangeFact => ({
  id: 'chg1',
  leaseId: 'lease1',
  businessId: 'biz1',
  businessName: 'Alder & Ash',
  status: 'PENDING',
  fields: ['landlordPayout'],
  requestedOn: AS_OF,
  effectiveOn: addDays(AS_OF, 5),
  appliedOn: null,
  approvedBy: null,
  upcomingPayouts: [],
  ...over,
});

const payout = (scheduledFor: string, status = 'SCHEDULED') => ({
  id: `p-${scheduledFor}`,
  scheduledFor,
  amountCents: 340_000,
  status,
});

let n = 0;
const landlord = (over: Partial<LandlordAccountFact> = {}): LandlordAccountFact => {
  n += 1;
  return {
    leaseId: `lease${n}`,
    businessId: `biz${n}`,
    businessName: `Business ${n}`,
    ownerUserId: `user${n}`,
    landlordName: 'Harbor View Properties',
    holderName: 'Harbor View Properties LLC',
    routingNumber: '123456789',
    last4: '4321',
    payoutToken: `mock_landlord_${n}`,
    hasOpenPlan: true,
    ...over,
  };
};

const bank = (over: Partial<BankAccountFact> = {}): BankAccountFact => {
  n += 1;
  return {
    bankLinkId: `link${n}`,
    businessId: `biz${n}`,
    businessName: `Business ${n}`,
    dba: null,
    ownerUserId: `user${n}`,
    accountToken: `mock_acct_${n}`,
    mask: '1000',
    ...over,
  };
};

const application = (over: Partial<ApplicationFact> = {}): ApplicationFact => {
  n += 1;
  return {
    id: `app${n}`,
    businessId: `biz${n}`,
    businessName: `Business ${n}`,
    ownerUserId: 'user1',
    status: 'APPROVED',
    createdOn: AS_OF,
    submittedOn: AS_OF,
    declinedOn: null,
    ...over,
  };
};

describe('fraud.landlord_change_pending', () => {
  it('is high when a payout falls due within the proximity window of the request', () => {
    const data = inputs({
      leaseChanges: [change({ upcomingPayouts: [payout(addDays(AS_OF, 2), 'HELD')] })],
    });
    const [alert] = run(landlordChangePending, data);
    expect(alert).toMatchObject({
      severity: 'HIGH',
      subjectType: 'lease',
      subjectId: 'lease1',
      dedupeKey: 'lease_change:chg1',
      detail: { heldPayouts: 1 },
    });
    expectDedupes(landlordChangePending, data);
  });

  it('is a warning when no payout is near', () => {
    const [alert] = run(
      landlordChangePending,
      inputs({ leaseChanges: [change({ upcomingPayouts: [payout(addDays(AS_OF, 25))] })] }),
    );
    expect(alert!.severity).toBe('WARNING');
  });

  it('does not fire without a pending change', () => {
    expect(run(landlordChangePending, inputs())).toEqual([]);
    expect(
      run(landlordChangePending, inputs({ leaseChanges: [change({ status: 'APPLIED' })] })),
    ).toEqual([]);
  });
});

describe('fraud.landlord_change_before_payout', () => {
  const applied = (over: Partial<LeaseChangeFact> = {}) =>
    change({ status: 'APPLIED', appliedOn: addDays(AS_OF, -2), ...over });

  it('fires when an applied change is followed by a payout that has not gone out', () => {
    const data = inputs({
      leaseChanges: [applied({ upcomingPayouts: [payout(addDays(AS_OF, 3))] })],
    });
    expect(run(landlordChangeBeforePayout, data)).toMatchObject([
      { severity: 'WARNING', dedupeKey: 'lease_change_applied:chg1' },
    ]);
    expectDedupes(landlordChangeBeforePayout, data);
  });

  it('does not fire once the payout is paid, when it is far off, or for a pending change', () => {
    expect(run(landlordChangeBeforePayout, inputs({ leaseChanges: [applied()] }))).toEqual([]);
    expect(
      run(
        landlordChangeBeforePayout,
        inputs({ leaseChanges: [applied({ upcomingPayouts: [payout(addDays(AS_OF, 20))] })] }),
      ),
    ).toEqual([]);
    expect(
      run(
        landlordChangeBeforePayout,
        inputs({ leaseChanges: [change({ upcomingPayouts: [payout(addDays(AS_OF, 1))] })] }),
      ),
    ).toEqual([]);
  });
});

describe('fraud.landlord_is_borrower_account', () => {
  it('fires when the payout token is any linked bank account', () => {
    const lease = landlord({ payoutToken: 'mock_acct_shared' });
    const data = inputs({
      landlordAccounts: [lease],
      bankAccounts: [bank({ accountToken: 'mock_acct_shared' })],
    });
    expect(run(landlordIsBorrowerAccount, data)).toMatchObject([
      { severity: 'CRITICAL', subjectId: lease.leaseId, detail: { matchesOwnAccount: false } },
    ]);
    expectDedupes(landlordIsBorrowerAccount, data);
  });

  it("fires on the business's own account by last 4 and account holder name", () => {
    const lease = landlord({ businessId: 'bizA', last4: '7788', holderName: 'Blue Door Bakery' });
    const own = bank({ businessId: 'bizA', businessName: 'Blue Door Bakery LLC', mask: '7788' });
    expect(
      run(landlordIsBorrowerAccount, inputs({ landlordAccounts: [lease], bankAccounts: [own] })),
    ).toMatchObject([{ detail: { matchesOwnAccount: true } }]);
  });

  it('does not fire on the last 4 alone, or on unrelated accounts', () => {
    const lease = landlord({ businessId: 'bizA', last4: '7788' });
    const own = bank({ businessId: 'bizA', businessName: 'Blue Door Bakery LLC', mask: '7788' });
    expect(
      run(landlordIsBorrowerAccount, inputs({ landlordAccounts: [lease], bankAccounts: [own] })),
    ).toEqual([]);
    expect(
      run(
        landlordIsBorrowerAccount,
        inputs({ landlordAccounts: [landlord()], bankAccounts: [bank()] }),
      ),
    ).toEqual([]);
  });

  it('is not resolved by the monitor: money may already have gone there', () => {
    expect(landlordIsBorrowerAccount.autoResolves).toBe(false);
  });
});

describe('fraud.shared_landlord_account', () => {
  const shared = (users: number, by: 'token' | 'account') =>
    Array.from({ length: users }, () =>
      by === 'token'
        ? landlord({ payoutToken: 'mock_landlord_same', routingNumber: `${100000000 + n}` })
        : landlord({ routingNumber: '021000021', last4: '9034' }),
    );

  it('fires at the threshold of unrelated users, by token or by routing and last 4', () => {
    for (const by of ['token', 'account'] as const) {
      const data = inputs({ landlordAccounts: shared(3, by) });
      expect(run(sharedLandlordAccount, data)).toMatchObject([
        { severity: 'WARNING', detail: { users: 3 } },
      ]);
      expectDedupes(sharedLandlordAccount, data);
    }
  });

  it('is high at the higher threshold', () => {
    const [alert] = run(sharedLandlordAccount, inputs({ landlordAccounts: shared(5, 'account') }));
    expect(alert!.severity).toBe('HIGH');
  });

  it('does not fire for two tenants of one landlord, or several leases of one user', () => {
    expect(run(sharedLandlordAccount, inputs({ landlordAccounts: shared(2, 'account') }))).toEqual(
      [],
    );
    const oneUser = shared(4, 'account').map((l) => ({ ...l, ownerUserId: 'same' }));
    expect(run(sharedLandlordAccount, inputs({ landlordAccounts: oneUser }))).toEqual([]);
  });

  it('raises one alert when the same leases match by token and by account number', () => {
    const leases = Array.from({ length: 3 }, () =>
      landlord({ payoutToken: 'mock_landlord_same', routingNumber: '021000021', last4: '9034' }),
    );
    expect(run(sharedLandlordAccount, inputs({ landlordAccounts: leases }))).toHaveLength(1);
  });
});

describe('fraud.shared_bank_account', () => {
  it('is high when two users link one account', () => {
    const data = inputs({
      bankAccounts: [bank({ accountToken: 'mock_acct_x' }), bank({ accountToken: 'mock_acct_x' })],
    });
    expect(run(sharedBankAccount, data)).toMatchObject([
      { severity: 'HIGH', detail: { users: 2 } },
    ]);
    expectDedupes(sharedBankAccount, data);
  });

  it('is informational when one user links it to two businesses', () => {
    const [alert] = run(
      sharedBankAccount,
      inputs({
        bankAccounts: [
          bank({ accountToken: 'mock_acct_x', ownerUserId: 'u' }),
          bank({ accountToken: 'mock_acct_x', ownerUserId: 'u' }),
        ],
      }),
    );
    expect(alert!.severity).toBe('INFO');
  });

  it('does not fire for separate accounts, or one business linking an account twice', () => {
    expect(run(sharedBankAccount, inputs({ bankAccounts: [bank(), bank()] }))).toEqual([]);
    expect(
      run(
        sharedBankAccount,
        inputs({
          bankAccounts: [
            bank({ accountToken: 'mock_acct_x', businessId: 'b' }),
            bank({ accountToken: 'mock_acct_x', businessId: 'b' }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('fraud.application_velocity', () => {
  const many = (count: number, over: Partial<ApplicationFact> = {}) =>
    Array.from({ length: count }, () => application(over));

  it('fires at four applications from one user in the window, high at eight', () => {
    const data = inputs({ applications: many(4) });
    expect(run(applicationVelocity, data)).toMatchObject([
      { severity: 'WARNING', subjectType: 'user', subjectId: 'user1' },
    ]);
    expectDedupes(applicationVelocity, data);
    expect(run(applicationVelocity, inputs({ applications: many(8) }))[0]!.severity).toBe('HIGH');
  });

  it('does not fire below the threshold, across users, or outside the window', () => {
    expect(run(applicationVelocity, inputs({ applications: many(3) }))).toEqual([]);
    const spread = many(4).map((a, i) => ({ ...a, ownerUserId: `u${i}` }));
    expect(run(applicationVelocity, inputs({ applications: spread }))).toEqual([]);
    expect(
      run(
        applicationVelocity,
        inputs({ applications: many(4, { createdOn: addDays(AS_OF, -7) }) }),
      ),
    ).toEqual([]);
  });
});

describe('fraud.reapply_after_decline', () => {
  const declined = application({
    status: 'DECLINED',
    createdOn: addDays(AS_OF, -10),
    declinedOn: addDays(AS_OF, -10),
  });

  it('fires on two more applications after a decline', () => {
    const data = inputs({
      applications: [
        declined,
        application({ createdOn: addDays(AS_OF, -5) }),
        application({ createdOn: addDays(AS_OF, -1) }),
      ],
    });
    expect(run(reapplyAfterDecline, data)).toMatchObject([
      { severity: 'WARNING', detail: { declinedApplicationId: declined.id } },
    ]);
    expectDedupes(reapplyAfterDecline, data);
  });

  it('does not fire on one more, on applications before the decline, or on an old decline', () => {
    expect(
      run(
        reapplyAfterDecline,
        inputs({ applications: [declined, application({ createdOn: addDays(AS_OF, -5) })] }),
      ),
    ).toEqual([]);
    expect(
      run(
        reapplyAfterDecline,
        inputs({
          applications: [
            declined,
            application({ createdOn: addDays(AS_OF, -20) }),
            application({ createdOn: addDays(AS_OF, -15) }),
          ],
        }),
      ),
    ).toEqual([]);
    const old = { ...declined, declinedOn: addDays(AS_OF, -40), createdOn: addDays(AS_OF, -40) };
    expect(
      run(reapplyAfterDecline, inputs({ applications: [old, application(), application()] })),
    ).toEqual([]);
  });
});

describe('fraud.screening_hit', () => {
  const screening = (over: Partial<ScreeningFact> = {}): ScreeningFact => ({
    id: 'scr1',
    businessId: 'biz1',
    businessName: 'Meridian Supply',
    partyType: 'OWNER',
    partyRef: 'owner1',
    result: 'POSSIBLE_MATCH',
    cleared: false,
    screenedOn: AS_OF,
    leaseChangeId: null,
    activeParty: false,
    ...over,
  });

  it('is high for a possible match and critical for a match', () => {
    const data = inputs({ screenings: [screening(), screening({ id: 'scr2', result: 'MATCH' })] });
    expect(run(screeningHit, data).map((a) => [a.subjectId, a.severity])).toEqual([
      ['scr1', 'HIGH'],
      ['scr2', 'CRITICAL'],
    ]);
    expectDedupes(screeningHit, data);
  });

  it('does not fire for a clear result or a hit a reviewer has cleared', () => {
    expect(
      run(
        screeningHit,
        inputs({ screenings: [screening({ result: 'CLEAR' }), screening({ cleared: true })] }),
      ),
    ).toEqual([]);
  });
});
