import type { Tx } from '../../db.ts';

export class InsufficientCapitalError extends Error {
  constructor(
    readonly requestedCents: number,
    readonly availableCents: number,
  ) {
    super(`Insufficient capital: requested ${requestedCents}, available ${availableCents}`);
    this.name = 'InsufficientCapitalError';
  }
}

/**
 * The source of funds that fronts landlord payouts. This is the seam where a real business
 * connects a credit facility, a fund, or its own balance sheet. The interface is deliberately
 * small: tell me what is available, let me reserve against it, and let me add to it.
 *
 * All methods take the current database transaction so capital checks commit atomically with
 * the ledger postings and status changes they protect.
 */
export interface CapitalProvider {
  readonly name: string;
  /** Cash currently available to front payouts. */
  availableCents(tx: Tx): Promise<number>;
  /**
   * Confirms `amountCents` can be drawn right now. Throws InsufficientCapitalError otherwise.
   * The actual movement is recorded by the caller's ledger posting (receivable debit, pool credit).
   */
  reserve(tx: Tx, amountCents: number, reference: string): Promise<void>;
  /** Adds capital to the pool, recorded as pool equity. */
  fund(tx: Tx, amountCents: number, description: string): Promise<void>;
}
