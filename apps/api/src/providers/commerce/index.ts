import type { Config } from '../../config.ts';
import { MockCommerceDataProvider } from './mock.ts';
import { SquareCommerceDataProvider } from './square.ts';
import type { CommerceDataProvider } from './types.ts';

export type { CommerceDataProvider, LinkedCommerceAccount } from './types.ts';

export function createCommerceDataProvider(config: Config): CommerceDataProvider {
  switch (config.COMMERCE_PROVIDER) {
    case 'square':
      return new SquareCommerceDataProvider(config);
    case 'mock':
    default:
      return new MockCommerceDataProvider();
  }
}
