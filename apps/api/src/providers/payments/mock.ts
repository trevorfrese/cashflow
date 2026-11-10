import { randomUUID } from 'node:crypto';

import type { ChargeInput, PaymentResult, PaymentsProvider, PayoutInput } from './types.ts';

/**
 * In-memory payments. Succeeds unless the token contains "fail", which lets tests and demos
 * exercise failure paths (a lease with landlordPayoutToken "mock_fail", for example).
 * Idempotency keys are remembered for the life of the process.
 */
export class MockPaymentsProvider implements PaymentsProvider {
  readonly name = 'mock';
  private readonly seen = new Map<string, PaymentResult>();
  readonly calls: Array<{ kind: 'payout' | 'charge'; input: PayoutInput | ChargeInput }> = [];

  async payout(input: PayoutInput): Promise<PaymentResult> {
    return this.run('payout', input, input.destinationToken);
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    return this.run('charge', input, input.sourceToken);
  }

  private run(
    kind: 'payout' | 'charge',
    input: PayoutInput | ChargeInput,
    token: string,
  ): PaymentResult {
    const key = `${kind}:${input.idempotencyKey}`;
    const prior = this.seen.get(key);
    if (prior) return prior;

    this.calls.push({ kind, input });
    const result: PaymentResult = token.includes('fail')
      ? { ok: false, providerRef: null, failureReason: 'Mock failure requested by token' }
      : { ok: true, providerRef: `mock_${kind}_${randomUUID()}` };
    this.seen.set(key, result);
    return result;
  }
}
