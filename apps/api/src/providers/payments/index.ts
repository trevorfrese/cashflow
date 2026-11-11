import type { Config } from '../../config.ts';
import { MockPaymentsProvider } from './mock.ts';
import { StripePaymentsProvider } from './stripe.ts';
import type { PaymentsProvider } from './types.ts';

export type {
  ChargeInput,
  PaymentResult,
  PaymentReturn,
  PaymentsProvider,
  PayoutInput,
  ReturnsQuery,
} from './types.ts';

export function createPaymentsProvider(config: Config): PaymentsProvider {
  switch (config.PAYMENTS_PROVIDER) {
    case 'stripe':
      return new StripePaymentsProvider(config);
    case 'mock':
    default:
      return new MockPaymentsProvider();
  }
}
