import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for tokens that platforms and aggregators issue to CashFlow.
 *
 * AES-256-GCM with a key derived by HKDF-SHA256 from `CONNECTION_TOKEN_KEY`. Every value gets
 * a fresh 12 byte IV, and the business it belongs to is bound in as additional authenticated
 * data, so a ciphertext copied onto another business's row does not decrypt. The stored form
 * is `v1.<keyId>.<iv>.<tag>.<ciphertext>`, each part base64url.
 *
 * Without a configured key the vault uses a fixed sandbox key (key id `sandbox`) so that the
 * mock providers work out of the box. That key is public, in this file, and protects nothing:
 * `assertVaultReady` refuses it whenever a real adapter is configured, and `loadConfig`
 * refuses to start in that case.
 *
 * Nothing here logs. Callers must never put a token, plain or encrypted, in a response, a log
 * line, or an audit payload.
 */

const VERSION = 'v1';
const SALT = Buffer.from('cashflow/connection-tokens', 'utf8');
const INFO = Buffer.from('cashflow/connection-token/aes-256-gcm/v1', 'utf8');
/** Public and worthless by design. Only ever used with mock providers. */
const SANDBOX_SECRET = 'cashflow-sandbox-connection-token-key-not-secret';

export interface TokenVault {
  /** `sandbox` when no key is configured. */
  readonly keyId: 'env' | 'sandbox';
  encrypt(plaintext: string, aad: string): string;
  decrypt(stored: string, aad: string): string;
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, INFO, 32));
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** Minimum length of `CONNECTION_TOKEN_KEY`: 32 characters of a random token. */
export const MIN_TOKEN_KEY_LENGTH = 32;

export function createTokenVault(secret: string | undefined): TokenVault {
  const keyId = secret ? 'env' : 'sandbox';
  if (secret && secret.length < MIN_TOKEN_KEY_LENGTH) {
    throw new Error(
      `CONNECTION_TOKEN_KEY must be at least ${MIN_TOKEN_KEY_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  const key = deriveKey(secret ?? SANDBOX_SECRET);
  return {
    keyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [VERSION, keyId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
    },
    decrypt(stored, aad) {
      const parts = stored.split('.');
      if (parts.length !== 5 || parts[0] !== VERSION) {
        throw new Error('Stored token is not in a recognized format');
      }
      if (parts[1] !== keyId) {
        throw new Error(`Stored token was sealed with key "${parts[1]}", not "${keyId}"`);
      }
      const decipher = createDecipheriv('aes-256-gcm', key, unb64(parts[2]!));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(unb64(parts[3]!));
      return Buffer.concat([decipher.update(unb64(parts[4]!)), decipher.final()]).toString('utf8');
    },
  };
}

/** A real adapter must not run on the public sandbox key. */
export function assertVaultReady(vault: TokenVault, adapter: string): void {
  if (vault.keyId !== 'env') {
    throw new Error(
      `${adapter} needs CONNECTION_TOKEN_KEY: tokens it receives are encrypted at rest, and the sandbox key protects nothing.`,
    );
  }
}
