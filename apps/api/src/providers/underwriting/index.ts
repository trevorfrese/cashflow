import type { Config } from '../../config.ts';
import { MockUnderwritingProvider } from './mock.ts';
import type { UnderwritingProvider } from './types.ts';

export type { UnderwritingInput, UnderwritingProvider, UnderwritingResult } from './types.ts';

export function createUnderwritingProvider(config: Config): UnderwritingProvider {
  switch (config.UNDERWRITING_PROVIDER) {
    case 'mock':
    default:
      return new MockUnderwritingProvider();
  }
}
