import type { Config } from '../../config.ts';
import { CashFlowUnderwritingProvider } from './cashflow.ts';
import type { UnderwritingProvider } from './types.ts';

export type { UnderwritingInput, UnderwritingProvider, UnderwritingResult } from './types.ts';

export function createUnderwritingProvider(config: Config): UnderwritingProvider {
  switch (config.UNDERWRITING_PROVIDER) {
    case 'cashflow':
    case 'mock':
      // "mock" is accepted for backwards compatibility. The engine itself is real logic; what
      // makes a local setup a sandbox is the mock bank data feeding it.
      return new CashFlowUnderwritingProvider();
  }
}
