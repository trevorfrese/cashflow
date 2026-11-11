import { describe, expect, it } from 'vitest';

import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type { ConnectionFact, VeracityEventFact } from '../types.ts';
import {
  connectionUnhealthy,
  historyRewritten,
  payoutDestinationChanged,
  settlementMatchDrop,
  sharedPlatformAccount,
} from './connections.ts';

const conn = (over: Partial<ConnectionFact> = {}): ConnectionFact => ({
  connectionId: 'c1',
  kind: 'COMMERCE',
  businessId: 'b1',
  businessName: 'Blue Door Bakery',
  ownerUserId: 'u1',
  name: 'SQUARE',
  accessMethod: 'DIRECT_OAUTH',
  health: 'HEALTHY',
  status: 'LINKED',
  lastPulledOn: AS_OF,
  lastPullError: null,
  tokenExpiresOn: '2026-12-10',
  platformAccountId: 'm1',
  payoutDestinations: ['First Street Bank|4821'],
  hasActivePlan: true,
  ...over,
});

const assessed = (over: Partial<VeracityEventFact> = {}): VeracityEventFact => ({
  id: 'e1',
  businessId: 'b1',
  businessName: 'Blue Door Bakery',
  on: AS_OF,
  source: 'REFRESH',
  findingCodes: [],
  matchedShareByAmountBps: 10_000,
  payoutsConsidered: 60,
  hasActivePlan: true,
  ...over,
});

describe('payments.connection_unhealthy', () => {
  it('fires on a connection that needs reauth, fails, or has an expired token, on an active plan', () => {
    const data = inputs({
      connections: [
        conn({ connectionId: 'a', health: 'REAUTH_REQUIRED' }),
        conn({ connectionId: 'b', kind: 'BANK', health: 'ERROR' }),
        conn({ connectionId: 'c', tokenExpiresOn: '2026-11-01' }),
      ],
    });
    const alerts = run(connectionUnhealthy, data);
    expect(alerts.map((a) => [a.subjectId, a.severity])).toEqual([
      ['a', 'WARNING'],
      ['b', 'HIGH'],
      ['c', 'WARNING'],
    ]);
    expectDedupes(connectionUnhealthy, data);
  });

  it('does not fire on a healthy connection, a business without a plan, or a disconnected one', () => {
    const data = inputs({
      connections: [
        conn(),
        conn({ connectionId: 'x', health: 'ERROR', hasActivePlan: false }),
        conn({ connectionId: 'y', health: 'REVOKED', status: 'DISCONNECTED' }),
      ],
    });
    expect(run(connectionUnhealthy, data)).toEqual([]);
  });
});

describe('fraud.history_rewritten', () => {
  it('opens one alert per assessment that found history changed, critical when it flatters', () => {
    const data = inputs({
      veracityEvents: [
        assessed({ id: 'e1', findingCodes: ['HISTORY_REWRITTEN'] }),
        assessed({ id: 'e2', findingCodes: ['SALES_HISTORY_CHANGED'] }),
      ],
    });
    expect(run(historyRewritten, data).map((a) => a.severity)).toEqual(['CRITICAL', 'HIGH']);
    expectDedupes(historyRewritten, data);
  });

  it('does not fire on minor changes or a business without a plan', () => {
    const data = inputs({
      veracityEvents: [
        assessed({ findingCodes: ['HISTORY_MINOR_CHANGES'] }),
        assessed({ id: 'e3', findingCodes: ['HISTORY_REWRITTEN'], hasActivePlan: false }),
      ],
    });
    expect(run(historyRewritten, data)).toEqual([]);
  });
});

describe('fraud.payout_destination_changed', () => {
  it('fires once per change on a business with a plan', () => {
    const data = inputs({
      payoutDestinationChanges: [
        {
          eventId: 'p1',
          connectionId: 'c1',
          businessId: 'b1',
          businessName: 'Blue Door',
          on: AS_OF,
          fromMasks: ['4821'],
          toMasks: ['0731'],
          hasActivePlan: true,
        },
        {
          eventId: 'p2',
          connectionId: 'c2',
          businessId: 'b2',
          businessName: 'Other',
          on: AS_OF,
          fromMasks: ['1'],
          toMasks: ['2'],
          hasActivePlan: false,
        },
      ],
    });
    expect(run(payoutDestinationChanged, data).map((a) => a.subjectId)).toEqual(['c1']);
    expectDedupes(payoutDestinationChanged, data);
  });
});

describe('fraud.settlement_match_drop', () => {
  const p = MONITORING_POLICY.veracity;
  it('fires when the match falls sharply from the approval, high under half', () => {
    const warn = inputs({
      veracityEvents: [
        assessed({ id: 'd', source: 'DECISION', on: '2026-08-01', matchedShareByAmountBps: 9800 }),
        assessed({ id: 'r', matchedShareByAmountBps: 7000 }),
      ],
    });
    expect(run(settlementMatchDrop, warn).map((a) => a.severity)).toEqual(['WARNING']);
    expectDedupes(settlementMatchDrop, warn);
    const high = inputs({
      veracityEvents: [
        assessed({ id: 'd', source: 'DECISION', on: '2026-08-01', matchedShareByAmountBps: 9800 }),
        assessed({ id: 'r', matchedShareByAmountBps: p.settlementHighBelowBps - 1 }),
      ],
    });
    expect(run(settlementMatchDrop, high).map((a) => a.severity)).toEqual(['HIGH']);
  });

  it('does not fire on a small drop, a still good match, too few payouts, or no baseline', () => {
    for (const latest of [
      assessed({ id: 'r', matchedShareByAmountBps: 9000 }),
      assessed({ id: 'r', matchedShareByAmountBps: 4000, payoutsConsidered: 3 }),
    ]) {
      const data = inputs({
        veracityEvents: [
          assessed({
            id: 'd',
            source: 'DECISION',
            on: '2026-08-01',
            matchedShareByAmountBps: 9800,
          }),
          latest,
        ],
      });
      expect(run(settlementMatchDrop, data)).toEqual([]);
    }
    expect(
      run(
        settlementMatchDrop,
        inputs({ veracityEvents: [assessed({ matchedShareByAmountBps: 1000 })] }),
      ),
    ).toEqual([]);
  });
});

describe('fraud.shared_platform_account', () => {
  it('fires when businesses under different users share a platform account or payout account', () => {
    const data = inputs({
      connections: [
        conn(),
        conn({ connectionId: 'c2', businessId: 'b2', ownerUserId: 'u2', payoutDestinations: [] }),
        conn({
          connectionId: 'c3',
          businessId: 'b3',
          ownerUserId: 'u3',
          platformAccountId: 'm9',
          payoutDestinations: ['First Street Bank|4821'],
        }),
      ],
    });
    const alerts = run(sharedPlatformAccount, data);
    expect(alerts.map((a) => a.severity).sort()).toEqual(['WARNING', 'WARNING']);
    expectDedupes(sharedPlatformAccount, data);
  });

  it('does not fire for one owner with several businesses, or distinct accounts', () => {
    const data = inputs({
      connections: [
        conn(),
        conn({
          connectionId: 'c2',
          businessId: 'b2',
          platformAccountId: 'm2',
          payoutDestinations: ['First Street Bank|4821'],
        }),
      ],
    });
    expect(run(sharedPlatformAccount, data)).toEqual([]);
    const distinct = inputs({
      connections: [
        conn(),
        conn({
          connectionId: 'c2',
          businessId: 'b2',
          ownerUserId: 'u2',
          platformAccountId: 'm2',
          payoutDestinations: [],
        }),
      ],
    });
    expect(run(sharedPlatformAccount, distinct)).toEqual([]);
  });
});
