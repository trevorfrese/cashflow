import { createHash } from 'node:crypto';

import type {
  BankSnapshotPayload,
  CommerceSnapshotPayload,
  ConnectionKind,
  IsoDate,
} from '@cashflow/shared';

import type { Tx } from '../db.ts';
import type { DataSnapshot, Prisma } from '../generated/prisma/client.ts';

/**
 * Snapshots: every pull of a connection, stored as normalized, hashed, and never changed.
 *
 * The content hash is sha256 over a canonical serialization (object keys sorted at every
 * level, no whitespace), so the same data always hashes the same whatever order a provider
 * returned fields in. A decision stores the ids and hashes of the snapshots it read, so it can
 * be reproduced from them and anyone can check they were not altered. The table is append
 * only (a trigger rejects UPDATE and DELETE); a re-pull is a new row.
 *
 * The sandbox keeps the payload in Postgres JSON, with a size guard. Production would put the
 * payload in object storage (write once, versioned) and keep the key and hash here.
 */

/** Largest payload stored in the database. A year of a busy account is a few hundred KB. */
export const MAX_SNAPSHOT_BYTES = 5_000_000;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function contentHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export class SnapshotTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Snapshot payload is ${bytes} bytes, above the ${MAX_SNAPSHOT_BYTES} byte limit`);
    this.name = 'SnapshotTooLargeError';
  }
}

export interface NewSnapshot {
  kind: ConnectionKind;
  businessId: string;
  bankLinkId?: string;
  commerceLinkId?: string;
  provider: string;
  reason: 'CONNECT' | 'APPLICATION' | 'REFRESH' | 'REUNDERWRITE' | 'SEAT_VERIFIED';
  pulledAt: Date;
  windowFrom: IsoDate;
  windowTo: IsoDate;
  payload: BankSnapshotPayload | CommerceSnapshotPayload;
}

export function recordCounts(payload: NewSnapshot['payload']): Record<string, number> {
  return 'transactions' in payload
    ? { transactions: payload.transactions.length }
    : { days: payload.dailySales.length, payouts: payload.payouts.length };
}

export async function createSnapshot(tx: Tx, s: NewSnapshot): Promise<DataSnapshot> {
  const json = canonicalJson(s.payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLargeError(bytes);
  return tx.dataSnapshot.create({
    data: {
      kind: s.kind,
      businessId: s.businessId,
      bankLinkId: s.bankLinkId ?? null,
      commerceLinkId: s.commerceLinkId ?? null,
      provider: s.provider,
      reason: s.reason,
      pulledAt: s.pulledAt,
      windowFrom: s.windowFrom,
      windowTo: s.windowTo,
      contentHash: createHash('sha256').update(json).digest('hex'),
      recordCounts: recordCounts(s.payload),
      payloadBytes: bytes,
      payload: JSON.parse(json) as Prisma.InputJsonValue,
    },
  });
}

/** The newest snapshots of a connection, newest first. */
export function latestSnapshots(
  tx: Tx,
  where: { bankLinkId: string } | { commerceLinkId: string },
  take: number,
) {
  return tx.dataSnapshot.findMany({
    where,
    orderBy: [{ pulledAt: 'desc' }, { createdAt: 'desc' }],
    take,
  });
}

/** Recompute a stored snapshot's hash: true when the payload is what was hashed at the pull. */
export function verifySnapshot(s: Pick<DataSnapshot, 'payload' | 'contentHash'>): boolean {
  return contentHash(s.payload) === s.contentHash;
}
