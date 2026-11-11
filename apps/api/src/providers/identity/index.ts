import type { Config } from '../../config.ts';
import { MockIdentityProvider } from './mock.ts';
import type { IdentityProvider } from './types.ts';

export type {
  IdentityProvider,
  ScreeningOutput,
  ScreeningStatus,
  VerificationOutcome,
  VerificationResult,
} from './types.ts';

/**
 * The sandbox provider is the only implementation. A real vendor would be added here as a
 * new case that refuses to construct without its own explicit configuration, the same way
 * the Plaid and Stripe skeletons do.
 */
export function createIdentityProvider(config: Config): IdentityProvider {
  switch (config.IDENTITY_PROVIDER) {
    case 'mock':
    default:
      return new MockIdentityProvider();
  }
}
