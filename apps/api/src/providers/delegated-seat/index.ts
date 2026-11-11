import type { Config } from '../../config.ts';
import { MockDelegatedSeatProvider } from './mock.ts';
import { ToastSeatProvider } from './toast.ts';
import type { DelegatedSeatProvider } from './types.ts';

export type {
  DelegatedSeatProvider,
  ReportPuller,
  SeatHandle,
  SeatInvitationSpec,
} from './types.ts';
export { ReportPullError } from './types.ts';

export function createDelegatedSeatProvider(config: Config): DelegatedSeatProvider {
  switch (config.DELEGATED_SEAT_PROVIDER) {
    case 'toast':
      return new ToastSeatProvider(config);
    case 'mock':
    default:
      return new MockDelegatedSeatProvider();
  }
}
