import { DevWalkthrough } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { parseScenario } from '../providers/bank-link/synthetic.ts';
import { isPrivateAddress } from '../routes/dev.ts';
import { PERSONAS, personaByKey } from './personas.ts';
import { describePersonaState, type PersonaFacts } from './service.ts';

describe('the persona registry', () => {
  it('has unique keys and logins', () => {
    expect(new Set(PERSONAS.map((p) => p.key)).size).toBe(PERSONAS.length);
    expect(new Set(PERSONAS.map((p) => p.email)).size).toBe(PERSONAS.length);
    for (const p of PERSONAS) {
      expect(p.key).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(p.email).toMatch(/@cashflow\.local$/);
      expect(p.demonstrates.length).toBeGreaterThan(20);
      expect(p.screens.length).toBeGreaterThan(0);
    }
  });

  it('covers every state the dev menu promises', () => {
    for (const key of [
      'active-plan',
      'declined',
      'needs-info',
      'manual-review',
      'counter-offer',
      'delinquent',
      'charged-off',
      'identity-review',
      'landlord-change',
      'fresh-approved',
      'fresh-declined',
      'fresh-referred',
      'fresh-counter-offer',
    ]) {
      expect(personaByKey(key), key).toBeDefined();
    }
    expect(personaByKey('nope')).toBeUndefined();
  });

  it('keeps the demo login on the first persona', () => {
    expect(PERSONAS[0]!.email).toBe('demo@cashflow.local');
  });

  it('gives every fresh applicant a valid preset that names its sandbox scenario', () => {
    const fresh = PERSONAS.filter((p) => p.build.kind === 'fresh');
    expect(fresh.map((p) => p.group)).toEqual(fresh.map(() => 'FRESH'));
    const outcomes = new Set<string>();
    for (const p of fresh) {
      if (p.build.kind !== 'fresh') continue;
      const w = DevWalkthrough.parse(p.build.walkthrough);
      outcomes.add(w.outcome);
      // The token must steer the mock bank to the scenario the preset names, and must not
      // carry a keyword that makes the mock bank or the mock payments provider fail.
      expect(parseScenario(w.bankPublicToken).scenario, p.key).toBe(w.bankScenario);
      expect(w.bankPublicToken).not.toMatch(/fail|return_r/);
      expect(parseScenario(w.bankPublicToken).monthlyRevenueCents).toBe(
        w.business.statedMonthlyRevenueCents,
      );
    }
    expect([...outcomes].sort()).toEqual(['APPROVED', 'COUNTER_OFFER', 'DECLINED', 'IN_REVIEW']);
  });

  it('builds only fresh and instant personas one at a time', () => {
    const history = PERSONAS.filter((p) => p.build.kind === 'history').map((p) => p.key);
    expect(history.sort()).toEqual(['active-plan', 'charged-off', 'delinquent', 'landlord-change']);
  });
});

describe('describePersonaState', () => {
  const facts = (over: Partial<PersonaFacts>): PersonaFacts => ({
    exists: true,
    businessName: 'Blue Door Bakery',
    applicationStatus: 'APPROVED',
    approvedLimitCents: 1_000_000,
    leaseRentCents: 1_000_000,
    plan: null,
    heldPayout: false,
    ...over,
  });

  it('labels accounts with nothing in them', () => {
    expect(describePersonaState(facts({ exists: false, businessName: null })).label).toBe(
      'Not created yet',
    );
    expect(describePersonaState(facts({ businessName: null })).label).toBe('Nothing created yet');
  });

  it('labels plans by standing', () => {
    const plan = (status: string, delinquencyStatus: string) => ({ status, delinquencyStatus });
    expect(describePersonaState(facts({ plan: plan('ACTIVE', 'CURRENT') }))).toMatchObject({
      label: 'Active plan, current',
      tone: 'paid',
    });
    expect(
      describePersonaState(facts({ plan: plan('ACTIVE', 'CURRENT'), heldPayout: true })),
    ).toMatchObject({ label: 'Active plan, payout held', tone: 'due' });
    expect(
      describePersonaState(facts({ plan: plan('ACTIVE', 'DELINQUENT'), heldPayout: true })),
    ).toMatchObject({ label: 'Delinquent, payout held', tone: 'late' });
    expect(describePersonaState(facts({ plan: plan('ACTIVE', 'GRACE') })).tone).toBe('due');
    expect(describePersonaState(facts({ plan: plan('ACTIVE', 'DEFAULT') })).label).toBe(
      'In default',
    );
    expect(describePersonaState(facts({ plan: plan('CLOSED', 'CHARGED_OFF') }))).toMatchObject({
      label: 'Written off, plan closed',
      tone: 'late',
    });
    expect(describePersonaState(facts({ plan: plan('CLOSED', 'CURRENT') })).label).toBe(
      'Plan closed',
    );
    expect(describePersonaState(facts({ plan: plan('PAUSED', 'CURRENT') })).label).toBe(
      'Plan paused',
    );
  });

  it('labels decisions when there is no plan', () => {
    const state = (over: Partial<PersonaFacts>) => describePersonaState(facts(over)).label;
    expect(state({ applicationStatus: 'DECLINED' })).toBe('Declined');
    expect(state({ applicationStatus: 'NEEDS_INFO' })).toBe('Needs info');
    expect(state({ applicationStatus: 'IN_REVIEW' })).toBe('In review');
    expect(state({ applicationStatus: null })).toBe('Business set up, not applied');
    expect(state({ leaseRentCents: null })).toBe('Approved, no lease yet');
    expect(state({})).toBe('Lease linked, no plan yet');
    expect(state({ approvedLimitCents: 430_000, leaseRentCents: 600_000 })).toBe(
      'Approved below the lease rent',
    );
  });
});

describe('isPrivateAddress', () => {
  it('accepts this machine and private networks', () => {
    for (const ip of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '10.0.2.2',
      '192.168.1.20',
      '172.16.0.4',
      '172.31.255.1',
      'fd12:3456::1',
      'fe80::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('rejects public addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '193.168.1.1', '2001:4860:4860::8888', '']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
