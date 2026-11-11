import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.ts';
import { createIdentityProvider } from './index.ts';
import { MockIdentityProvider } from './mock.ts';

const provider = new MockIdentityProvider();

const business = (over: Record<string, unknown> = {}) => ({
  legalName: 'Blue Door Bakery LLC',
  dba: 'Blue Door Bakery',
  address: { line1: '412 Pine St', city: 'Portland', state: 'OR', postalCode: '97204' },
  taxIdLast4: '4821' as string | null,
  formationDate: '2021-03-01',
  ...over,
});

describe('MockIdentityProvider', () => {
  it('is the default, and the only, identity provider', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(32) });
    expect(config.IDENTITY_PROVIDER).toBe('mock');
    expect(createIdentityProvider(config).name).toBe('mock');
  });

  it('verifies an ordinary business and its owners', async () => {
    await expect(provider.verifyBusiness(business())).resolves.toMatchObject({
      status: 'VERIFIED',
      reasons: [],
    });
    const owners = await provider.verifyOwners([
      { ownerId: 'o1', fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 10_000 },
    ]);
    expect(owners).toEqual([
      expect.objectContaining({ ownerId: 'o1', status: 'VERIFIED', reasons: [] }),
    ]);
  });

  it('fails or refers a business by keyword, tax id 0000, or a missing tax id', async () => {
    await expect(
      provider.verifyBusiness(business({ legalName: 'Unverifiable Holdings LLC' })),
    ).resolves.toMatchObject({ status: 'FAILED', reasons: ['ENTITY_NOT_FOUND'] });
    await expect(
      provider.verifyBusiness(business({ dba: 'Mismatch Bakery' })),
    ).resolves.toMatchObject({ status: 'REVIEW', reasons: ['NAME_ADDRESS_MISMATCH'] });
    await expect(provider.verifyBusiness(business({ taxIdLast4: '0000' }))).resolves.toMatchObject({
      status: 'REVIEW',
      reasons: ['TAX_ID_MISMATCH'],
    });
    await expect(provider.verifyBusiness(business({ taxIdLast4: null }))).resolves.toMatchObject({
      status: 'REVIEW',
      reasons: ['TAX_ID_MISSING'],
    });
  });

  it('fails or refers an owner by keyword', async () => {
    const [failed, review] = await provider.verifyOwners([
      { ownerId: 'a', fullName: 'Pat Unverifiable', title: 'Owner', ownershipBps: 5000 },
      { ownerId: 'b', fullName: 'Lee Mismatch', title: 'Partner', ownershipBps: 5000 },
    ]);
    expect(failed).toMatchObject({ ownerId: 'a', status: 'FAILED' });
    expect(review).toMatchObject({ ownerId: 'b', status: 'REVIEW' });
  });

  it('screens clear by default and hits on keywords in the name or an alias', async () => {
    const screen = (name: string, aliases: string[] = []) =>
      provider.screenParty({ partyType: 'LANDLORD', name, aliases });
    await expect(screen('Harbor View Properties')).resolves.toMatchObject({ result: 'CLEAR' });
    await expect(screen('Watchlist Realty')).resolves.toMatchObject({ result: 'POSSIBLE_MATCH' });
    await expect(screen('Sanctioned Holdings')).resolves.toMatchObject({ result: 'MATCH' });
    await expect(screen('Harbor View', ['Sanctioned Trust'])).resolves.toMatchObject({
      result: 'MATCH',
    });
  });

  it('is deterministic: the same party gets the same reference every time', async () => {
    const input = { partyType: 'OWNER' as const, name: 'Morgan Watchlist' };
    const first = await provider.screenParty(input);
    const second = await provider.screenParty(input);
    expect(second).toEqual(first);
    const other = await provider.screenParty({ ...input, name: 'Jordan Watchlist' });
    expect(other.matchReference).not.toBe(first.matchReference);
  });
});
