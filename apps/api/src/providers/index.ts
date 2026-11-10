import type { Config } from '../config.ts';
import { createBankLinkProvider, type BankLinkProvider } from './bank-link/index.ts';
import { createCapitalProvider, type CapitalProvider } from './capital/index.ts';
import { createPaymentsProvider, type PaymentsProvider } from './payments/index.ts';
import { createUnderwritingProvider, type UnderwritingProvider } from './underwriting/index.ts';

export interface Providers {
  underwriting: UnderwritingProvider;
  bankLink: BankLinkProvider;
  payments: PaymentsProvider;
  capital: CapitalProvider;
}

/** Builds every provider from environment configuration. Mocks are the default everywhere. */
export function createProviders(config: Config): Providers {
  return {
    underwriting: createUnderwritingProvider(config),
    bankLink: createBankLinkProvider(config),
    payments: createPaymentsProvider(config),
    capital: createCapitalProvider(config),
  };
}

export type { BankLinkProvider, CapitalProvider, PaymentsProvider, UnderwritingProvider };
