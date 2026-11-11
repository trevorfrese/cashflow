import type { IsoDate } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import type { Tx } from '../../db.ts';
import { ACCOUNTS } from '../../ledger/accounts.ts';
import { accountBalance, postTransaction } from '../../ledger/service.ts';
import { type CapitalProvider, InsufficientCapitalError } from './types.ts';

/**
 * A funding pool that lives entirely in the ledger. Its balance is the natural balance of the
 * `capital_pool` asset account, so it goes down when landlords are paid and back up when
 * collected cash is swept in. Seed it with `fund()`.
 */
export class MockCapitalProvider implements CapitalProvider {
  readonly name = 'mock';

  async availableCents(tx: Tx): Promise<number> {
    return accountBalance(tx, ACCOUNTS.CAPITAL_POOL);
  }

  async reserve(tx: Tx, amountCents: number, _reference: string): Promise<void> {
    const available = await this.availableCents(tx);
    if (available < amountCents) {
      throw new InsufficientCapitalError(amountCents, available);
    }
  }

  async fund(
    tx: Tx,
    amountCents: number,
    description: string,
    effectiveDate: IsoDate = todayIso(),
  ): Promise<void> {
    await postTransaction(tx, {
      description,
      effectiveDate,
      referenceType: 'capital_funding',
      entries: [
        { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'DEBIT', amountCents },
        { accountCode: ACCOUNTS.POOL_EQUITY, direction: 'CREDIT', amountCents },
      ],
    });
  }
}
