import type { EngineInput, EngineResult } from '../../underwriting/engine.ts';

export type UnderwritingInput = EngineInput;
export type UnderwritingResult = EngineResult;

/**
 * Decides whether CashFlow will front rent for a business, and on what terms.
 * The default implementation is the in-house cash flow engine in src/underwriting. A
 * vendor backed implementation (a bureau pull, a third party cash flow score) would
 * implement the same interface and could blend its signal with the engine's.
 */
export interface UnderwritingProvider {
  readonly name: string;
  decide(input: UnderwritingInput): Promise<UnderwritingResult>;
}
