import { describe, expect, it } from 'vitest';

import { businessTokens, holderIsApplicant, matchBusinessName, samePerson } from './names.ts';

describe('business name matching', () => {
  it('ignores legal suffixes, punctuation and case', () => {
    expect(businessTokens('Blue Door Bakery, L.L.C.')).toEqual(['blue', 'door', 'bakery']);
    expect(matchBusinessName('BLUE DOOR BAKERY INC', ['Blue Door Bakery LLC'], 0.8).matched).toBe(
      true,
    );
    expect(matchBusinessName("Joe's Pizza", ['Joes Pizza Co'], 0.8).matched).toBe(true);
    expect(matchBusinessName('Alder and Ash', ['Alder & Ash Florist LLC'], 0.8).matched).toBe(true);
  });

  it('matches the trading name, a dba, a typo, and spacing', () => {
    expect(
      matchBusinessName('Blue Door Bakery', ['Acme Holdings LLC', 'Blue Door Bakery'], 0.8).matched,
    ).toBe(true);
    expect(
      matchBusinessName('Acme Holdings LLC dba Blue Door Bakery', ['Blue Door Bakery LLC'], 0.8)
        .matched,
    ).toBe(true);
    expect(matchBusinessName('Blue Door Bakkery', ['Blue Door Bakery'], 0.8).matched).toBe(true);
    expect(matchBusinessName('Bluedoor Bakery', ['Blue Door Bakery'], 0.8).score).toBe(1);
    expect(matchBusinessName('BlueDoor', ['Blue Door'], 0.8).matched).toBe(true);
  });

  it('does not match a different business, or one shared word', () => {
    expect(matchBusinessName('Harlow Ventures LLC', ['Blue Door Bakery LLC'], 0.8).matched).toBe(
      false,
    );
    expect(matchBusinessName('Blue Door Coffee', ['Blue Door Bakery'], 0.8).matched).toBe(false);
    expect(matchBusinessName('Bakery', ['Blue Door Bakery'], 0.8).matched).toBe(false);
  });
});

describe('people', () => {
  it('matches nicknames and initials, not a different surname', () => {
    expect(samePerson('Bob Smith', 'Robert Smith')).toBe(true);
    expect(samePerson('R. Smith', 'Robert Smith')).toBe(true);
    expect(samePerson('ROBERT J SMITH JR', 'Robert Smith')).toBe(true);
    expect(samePerson('Robert Jones', 'Robert Smith')).toBe(false);
    expect(samePerson('Alice Smith', 'Robert Smith')).toBe(false);
  });

  it('accepts a holder that is the business or an owner', () => {
    const a = { legalName: 'Blue Door Bakery LLC', dba: null, ownerNames: ['Dana Rivera'] };
    expect(holderIsApplicant('BLUE DOOR BAKERY', a, 0.8).as).toBe('BUSINESS');
    expect(holderIsApplicant('Dana M Rivera', a, 0.8).as).toBe('OWNER');
    expect(holderIsApplicant('Sam Rivera', a, 0.8).matched).toBe(false);
  });
});
