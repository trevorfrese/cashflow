import { describe, expect, it } from 'vitest';

import { MockBankLinkProvider } from './mock.ts';
import {
  decodeItemId,
  encodeItemId,
  generateHistory,
  generateHistoryAt,
  parseScenario,
} from './synthetic.ts';

const LINKED = '2026-11-09';

describe('sandbox bank, anchored on the link date', () => {
  it('is generateHistory up to the anchor and continues it afterwards', () => {
    const spec = parseScenario('healthy_rev_48000');
    const atLink = generateHistoryAt(spec, 'abcdef123456', LINKED, LINKED);
    expect(atLink).toEqual(generateHistory(spec, 'abcdef123456', LINKED));
    const later = generateHistoryAt(spec, 'abcdef123456', LINKED, '2026-12-20');
    expect(later.transactions.slice(0, atLink.transactions.length)).toEqual(atLink.transactions);
    expect(later.transactions.at(-1)!.date > LINKED).toBe(true);
  });

  it('round trips anchor and flags in the item id, and reads legacy ids as before', () => {
    const spec = parseScenario('healthy');
    const id = encodeItemId(spec, 'abc123', LINKED, ['personal', 'legacy']);
    expect(decodeItemId(id)).toMatchObject({ anchor: LINKED, flags: ['personal', 'legacy'] });
    expect(decodeItemId(encodeItemId(spec, 'abc123'))).toMatchObject({ anchor: null, flags: [] });
  });

  it('reports the holder it was linked for, and the keywords change it', async () => {
    let today = LINKED;
    const bank = new MockBankLinkProvider(() => today);
    const holder = { legalName: 'Blue Door Bakery LLC', ownerNames: ['Dana Rivera'] };
    const plain = await bank.exchangePublicToken('mock_healthy', holder);
    const creds = { providerItemId: plain.providerItemId, accessToken: plain.accessToken };
    expect(await bank.getIdentity(creds)).toMatchObject({
      ownerNames: ['Blue Door Bakery LLC'],
      accountType: 'BUSINESS',
    });
    expect(plain.institutionAuthorized).toBe(true);
    const accounts = await bank.listAccounts(creds);
    expect(accounts).toEqual([expect.objectContaining({ mask: plain.accountMask, shared: true })]);

    const odd = await bank.exchangePublicToken('mock_healthy_personal_hidden_legacy', holder);
    const oddCreds = { providerItemId: odd.providerItemId, accessToken: odd.accessToken };
    expect(await bank.getIdentity(oddCreds)).toMatchObject({
      ownerNames: ['Dana Rivera'],
      accountType: 'PERSONAL',
    });
    expect((await bank.listAccounts(oddCreds)).filter((a) => !a.shared)).toHaveLength(2);
    expect(odd.institutionAuthorized).toBe(false);

    const expiring = await bank.exchangePublicToken('mock_healthy_expired', holder);
    today = '2026-11-12';
    const status = await bank.getItemStatus({
      providerItemId: expiring.providerItemId,
      accessToken: expiring.accessToken,
    });
    expect(status.health).toBe('REAUTH_REQUIRED');
    await expect(
      bank.getTransactions(expiring.providerItemId, { from: '2026-01-01', to: today }),
    ).rejects.toThrow(/reauthorized/);
  });

  it('rewrites history on a later pull when asked to', async () => {
    let today = LINKED;
    const bank = new MockBankLinkProvider(() => today);
    const linked = await bank.exchangePublicToken('mock_overdrafts_rewrites');
    const range = { from: '2025-11-01', to: '2026-12-31' };
    const first = await bank.getTransactions(linked.providerItemId, range);
    today = '2026-11-25';
    const second = await bank.getTransactions(linked.providerItemId, range);
    const fees = (txs: typeof first) =>
      txs.filter((t) => t.category === 'NSF_FEE' && t.date <= LINKED);
    expect(fees(first).length).toBeGreaterThan(0);
    expect(fees(second)).toHaveLength(0);
  });
});
