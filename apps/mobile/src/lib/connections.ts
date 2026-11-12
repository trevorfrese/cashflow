import type { CommercePlatform, Connection, ConnectionList } from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';

import type { PillTone } from '@/components/Pill';

/**
 * Plain words for data connections. The server decides everything (method, tier, health,
 * actions); this only chooses how the app says it.
 */

/** Platforms with an API: the owner approves on the platform's site. Toast: a seat. */
export function connectsBySeat(platform: CommercePlatform): boolean {
  return platform === 'TOAST';
}

/** The sentence on the connect screen, before the owner leaves for the platform. */
export function methodPromise(platform: CommercePlatform): string {
  const name = COMMERCE_PLATFORM_LABELS[platform];
  return connectsBySeat(platform)
    ? `${name} has no way to approve access directly, so you add CashFlow's own read-only reports user to your ${name} account. We never see your password.`
    : `You will approve read-only access on ${name}'s site. We never see your password.`;
}

export function healthPill(c: Pick<Connection, 'health' | 'status'>): {
  label: string;
  tone: PillTone;
} {
  if (c.status === 'DISCONNECTED') return { label: 'Disconnected', tone: 'neutral' };
  switch (c.health) {
    case 'HEALTHY':
      return { label: 'Connected', tone: 'paid' };
    case 'PENDING':
      return { label: 'Waiting on you', tone: 'due' };
    case 'REAUTH_REQUIRED':
      return { label: 'Reconnect', tone: 'late' };
    case 'ERROR':
      return { label: 'Not updating', tone: 'late' };
    default:
      return { label: 'Revoked', tone: 'neutral' };
  }
}

export function trustLabel(tier: Connection['trustTier']): string {
  switch (tier) {
    case 'HIGH':
      return 'Verified at the source';
    case 'MEDIUM':
      return 'Verified';
    case 'LOW':
      return 'Still being checked';
    default:
      return 'Not in use';
  }
}

/** Every action the owner can take, connection actions first, without duplicates. */
export function pendingActions(list: ConnectionList | undefined) {
  if (!list) return [];
  const seen = new Set<string>();
  const out: Array<{ code: string; message: string; connectionId: string | null }> = [];
  for (const c of list.connections) {
    for (const a of c.actions) {
      if (seen.has(a.code)) continue;
      seen.add(a.code);
      out.push({ ...a, connectionId: c.id });
    }
  }
  for (const a of list.actions) {
    if (seen.has(a.code)) continue;
    seen.add(a.code);
    out.push({ ...a, connectionId: null });
  }
  return out;
}

/**
 * The query parameters of a redirect URL. React Native's URL does not implement
 * `searchParams`, so this parses the query by hand.
 */
export function redirectParams(url: string): Record<string, string> {
  const query = url.split('#')[0]!.split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    out[decodeURIComponent(k!)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}
