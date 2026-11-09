import { createHash, randomBytes } from 'node:crypto';

import type { Tx } from '../db.ts';

/** Refresh tokens are random, shown to the client once, and stored only as a SHA-256 hash. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueRefreshToken(tx: Tx, userId: string, ttlDays: number): Promise<string> {
  const { token, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await tx.refreshToken.create({ data: { userId, tokenHash: hash, expiresAt } });
  return token;
}

/**
 * Validates a refresh token and revokes it so each token can only be used once.
 * Returns the user id, or null if the token is unknown, expired, or already used.
 */
export async function consumeRefreshToken(tx: Tx, token: string): Promise<string | null> {
  const hash = hashRefreshToken(token);
  const row = await tx.refreshToken.findUnique({ where: { tokenHash: hash } });
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return row.userId;
}
