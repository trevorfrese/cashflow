import type { Config } from '../config.ts';
import { createBankLinkProvider, type BankLinkProvider } from './bank-link/index.ts';
import { createCapitalProvider, type CapitalProvider } from './capital/index.ts';
import { createCommerceDataProvider, type CommerceRouter } from './commerce/index.ts';
import { createDelegatedSeatProvider, type DelegatedSeatProvider } from './delegated-seat/index.ts';
import { createTokenVault, type TokenVault } from '../crypto/token-vault.ts';
import { createIdentityProvider, type IdentityProvider } from './identity/index.ts';
import { createPaymentsProvider, type PaymentsProvider } from './payments/index.ts';
import { createUnderwritingProvider, type UnderwritingProvider } from './underwriting/index.ts';

export interface Providers {
  underwriting: UnderwritingProvider;
  bankLink: BankLinkProvider;
  commerce: CommerceRouter;
  /** Platforms without an API: a read-only seat for CashFlow's own service user. */
  delegatedSeat: DelegatedSeatProvider;
  /** Encryption at rest for platform and aggregator tokens. */
  vault: TokenVault;
  payments: PaymentsProvider;
  capital: CapitalProvider;
  identity: IdentityProvider;
}

/** Builds every provider from environment configuration. Mocks are the default everywhere. */
export function createProviders(config: Config): Providers {
  return {
    underwriting: createUnderwritingProvider(config),
    bankLink: createBankLinkProvider(config),
    commerce: createCommerceDataProvider(config),
    delegatedSeat: createDelegatedSeatProvider(config),
    vault: createTokenVault(config.CONNECTION_TOKEN_KEY),
    payments: createPaymentsProvider(config),
    capital: createCapitalProvider(config),
    identity: createIdentityProvider(config),
  };
}

export type {
  BankLinkProvider,
  CapitalProvider,
  CommerceRouter,
  DelegatedSeatProvider,
  IdentityProvider,
  PaymentsProvider,
  UnderwritingProvider,
};
