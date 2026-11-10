import type { Config } from '../../config.ts';
import { MockCapitalProvider } from './mock.ts';
import type { CapitalProvider } from './types.ts';

export { InsufficientCapitalError } from './types.ts';
export type { CapitalProvider } from './types.ts';

export function createCapitalProvider(config: Config): CapitalProvider {
  switch (config.CAPITAL_PROVIDER) {
    case 'mock':
    default:
      return new MockCapitalProvider();
  }
}
