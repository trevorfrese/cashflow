import { randomUUID } from 'node:crypto';

import { addDays, type IsoDate } from '@cashflow/shared';

import { returnCodeReason } from '../../servicing/policy.ts';
import type {
  ChargeInput,
  PaymentResult,
  PaymentReturn,
  PaymentsProvider,
  PayoutInput,
  ReturnsQuery,
} from './types.ts';

/** Days after the payment that the mock bank sends a return back. */
export const MOCK_RETURN_DAYS = 2;
/** The same for a `late_return_` token: an unauthorized return can arrive weeks later. */
export const MOCK_LATE_RETURN_DAYS = 21;

export interface MockReturnPlan {
  returnCode: string;
  afterDays: number;
  /** Only the first payment on this token comes back. Later ones settle. */
  once: boolean;
}

/**
 * What a token asks the mock to do with a payment that it accepts. Keywords, anywhere in the
 * token, case insensitive:
 *
 *   return_r01        accepted, then returned 2 days later with code R01 (insufficient funds)
 *   return_r02        the same with R02 (account closed). Any two digit code works.
 *   late_return_r10   accepted, then returned 21 days later with R10 (unauthorized)
 *   ..._once          add `_once` and only the first payment on the token is returned
 *
 * Null when the token asks for nothing.
 */
export function parseReturnPlan(token: string): MockReturnPlan | null {
  const match = /(late_)?return_(r\d{2})(_once)?/i.exec(token);
  if (!match) return null;
  return {
    returnCode: match[2]!.toUpperCase(),
    afterDays: match[1] ? MOCK_LATE_RETURN_DAYS : MOCK_RETURN_DAYS,
    once: match[3] !== undefined,
  };
}

/**
 * In-memory payments. A payment succeeds unless its token contains "fail", which rejects it
 * on the spot, or a `return_` keyword (see `parseReturnPlan`), which accepts it and sends it
 * back later through `listReturns`. That lets tests and demos exercise every failure path:
 * a lease with landlordPayoutToken "mock_fail", a bank account token ending
 * "return_r01", and so on.
 *
 * Idempotency keys and pending returns are remembered for the life of the process. A return
 * scheduled in one process is never reported in another, which is fine for the API server,
 * the seed, and the tests, each of which is one process.
 */
export class MockPaymentsProvider implements PaymentsProvider {
  readonly name = 'mock';
  private readonly seen = new Map<string, PaymentResult>();
  private readonly returns: PaymentReturn[] = [];
  private readonly returnedOnce = new Set<string>();
  private readonly refs = new Map<string, { kind: 'payout' | 'charge'; amountCents: number }>();
  readonly calls: Array<{ kind: 'payout' | 'charge'; input: PayoutInput | ChargeInput }> = [];

  async payout(input: PayoutInput): Promise<PaymentResult> {
    return this.run('payout', input, input.destinationToken);
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    return this.run('charge', input, input.sourceToken);
  }

  async listReturns(query: ReturnsQuery): Promise<PaymentReturn[]> {
    return this.returns
      .filter((r) => r.returnedOn >= query.from && r.returnedOn <= query.to)
      .sort((a, b) => (a.returnedOn < b.returnedOn ? -1 : a.returnedOn > b.returnedOn ? 1 : 0));
  }

  /** Test hook: forget every call, idempotency key, and pending return. */
  reset(): void {
    this.seen.clear();
    this.returns.length = 0;
    this.returnedOnce.clear();
    this.refs.clear();
    this.calls.length = 0;
  }

  /** Test hook: make an accepted payment come back, as if the bank had returned it. */
  scheduleReturn(providerRef: string, returnCode: string, returnedOn: IsoDate): void {
    const call = this.refs.get(providerRef);
    if (!call) throw new Error(`Unknown mock payment: ${providerRef}`);
    this.returns.push({
      providerRef,
      kind: call.kind,
      amountCents: call.amountCents,
      returnCode,
      reason: returnCodeReason(returnCode),
      returnedOn,
    });
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
    let result: PaymentResult;
    if (token.includes('fail')) {
      result = { ok: false, providerRef: null, failureReason: 'Mock failure requested by token' };
    } else {
      const providerRef = `mock_${kind}_${randomUUID()}`;
      result = { ok: true, providerRef };
      this.refs.set(providerRef, { kind, amountCents: input.amountCents });
      const plan = parseReturnPlan(token);
      const onceKey = `${kind}:${token}`;
      if (plan && !(plan.once && this.returnedOnce.has(onceKey))) {
        this.returnedOnce.add(onceKey);
        this.scheduleReturn(
          providerRef,
          plan.returnCode,
          addDays(input.effectiveDate, plan.afterDays),
        );
      }
    }
    this.seen.set(key, result);
    return result;
  }
}
