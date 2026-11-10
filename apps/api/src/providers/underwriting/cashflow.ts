import { decide } from '../../underwriting/engine.ts';
import type { UnderwritingInput, UnderwritingProvider, UnderwritingResult } from './types.ts';

/** The in-house cash flow underwriting engine. Deterministic, explainable, fully offline. */
export class CashFlowUnderwritingProvider implements UnderwritingProvider {
  readonly name = 'cashflow-v1';

  async decide(input: UnderwritingInput): Promise<UnderwritingResult> {
    return decide(input);
  }
}
