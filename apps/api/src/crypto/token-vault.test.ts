import { describe, expect, it } from 'vitest';

import { assertVaultReady, createTokenVault } from './token-vault.ts';

const KEY = 'k'.repeat(48);

describe('token vault', () => {
  it('round trips and never stores the plaintext', () => {
    const vault = createTokenVault(KEY);
    const sealed = vault.encrypt('sq0atp-secret-token', 'biz_1');
    expect(sealed).not.toContain('secret');
    expect(sealed.startsWith('v1.env.')).toBe(true);
    expect(vault.decrypt(sealed, 'biz_1')).toBe('sq0atp-secret-token');
  });

  it('uses a fresh IV every time', () => {
    const vault = createTokenVault(KEY);
    expect(vault.encrypt('same', 'a')).not.toBe(vault.encrypt('same', 'a'));
  });

  it('refuses a ciphertext moved to another business', () => {
    const vault = createTokenVault(KEY);
    const sealed = vault.encrypt('token', 'biz_1');
    expect(() => vault.decrypt(sealed, 'biz_2')).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const vault = createTokenVault(KEY);
    const parts = vault.encrypt('token', 'biz_1').split('.');
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[4] = ct.toString('base64url');
    expect(() => vault.decrypt(parts.join('.'), 'biz_1')).toThrow();
  });

  it('refuses a token sealed under a different key', () => {
    const sealed = createTokenVault(KEY).encrypt('token', 'biz_1');
    expect(() => createTokenVault('z'.repeat(48)).decrypt(sealed, 'biz_1')).toThrow();
    expect(() => createTokenVault(undefined).decrypt(sealed, 'biz_1')).toThrow(/key "env"/);
  });

  it('works on the sandbox key for mocks, and a real adapter refuses it', () => {
    const sandbox = createTokenVault(undefined);
    expect(sandbox.keyId).toBe('sandbox');
    expect(sandbox.decrypt(sandbox.encrypt('t', 'b'), 'b')).toBe('t');
    expect(() => assertVaultReady(sandbox, 'Square')).toThrow(/CONNECTION_TOKEN_KEY/);
    expect(() => assertVaultReady(createTokenVault(KEY), 'Square')).not.toThrow();
  });

  it('rejects a short key', () => {
    expect(() => createTokenVault('short')).toThrow(/at least 32/);
  });
});
