import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import type { User } from '../generated/prisma/client.ts';
import { recordAudit } from '../services/audit.ts';

/**
 * Login lockout. After `LOGIN_MAX_FAILURES` wrong passwords in a row an account is locked
 * for `LOGIN_LOCKOUT_MINUTES`, and an audit event is written. Rate limiting counts requests
 * per address; this counts failures per account, which is what stops a guessing attack that
 * comes from many addresses. A correct password while locked is refused too: otherwise the
 * lock would only slow down the guesses that were wrong anyway.
 */

type LockoutConfig = Pick<Config, 'LOGIN_MAX_FAILURES' | 'LOGIN_LOCKOUT_MINUTES'>;

export function lockedError(until: Date, now: Date = new Date()) {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  return new AppError(
    429,
    'LOGIN_LOCKED',
    `Too many failed sign in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}`,
  );
}

/** Throws when the account is locked right now. */
export function assertNotLocked(user: Pick<User, 'lockedUntil'>, now: Date = new Date()): void {
  if (user.lockedUntil && user.lockedUntil > now) throw lockedError(user.lockedUntil, now);
}

/** Count a wrong password. Locks the account, and returns the lock, on the last one allowed. */
export async function recordFailedLogin(
  db: Db,
  user: Pick<User, 'id' | 'failedLoginCount'>,
  config: LockoutConfig,
  now: Date = new Date(),
): Promise<Date | null> {
  if (config.LOGIN_MAX_FAILURES === 0) return null;
  const failures = user.failedLoginCount + 1;
  if (failures < config.LOGIN_MAX_FAILURES) {
    await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: failures, lastFailedLoginAt: now },
    });
    return null;
  }
  const lockedUntil = new Date(now.getTime() + config.LOGIN_LOCKOUT_MINUTES * 60_000);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lastFailedLoginAt: now, lockedUntil },
    });
    await recordAudit(tx, {
      actor: { type: 'system', id: 'auth' },
      eventType: 'LOGIN_LOCKED',
      subjectType: 'user',
      subjectId: user.id,
      payload: {
        failures,
        lockedUntil: lockedUntil.toISOString(),
        lockoutMinutes: config.LOGIN_LOCKOUT_MINUTES,
      },
      severity: 'warning',
      at: now,
    });
  });
  return lockedUntil;
}

export async function recordSuccessfulLogin(
  db: Db,
  user: Pick<User, 'id' | 'failedLoginCount' | 'lockedUntil'>,
): Promise<void> {
  if (user.failedLoginCount === 0 && user.lockedUntil === null) return;
  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}
