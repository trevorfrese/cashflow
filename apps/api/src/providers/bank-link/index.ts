import type { Config } from '../../config.ts';
import { MockBankLinkProvider } from './mock.ts';
import { PlaidBankLinkProvider } from './plaid.ts';
import type { BankLinkProvider } from './types.ts';

export type {
  BankAccountIdentity,
  BankCredentials,
  BankLinkProvider,
  ItemStatus,
  LinkedAccount,
  SandboxHolder,
} from './types.ts';
export { ReauthRequiredError } from './types.ts';

export function createBankLinkProvider(config: Config): BankLinkProvider {
  switch (config.BANK_LINK_PROVIDER) {
    case 'plaid':
      return new PlaidBankLinkProvider(config);
    case 'mock':
    default:
      return new MockBankLinkProvider();
  }
}
