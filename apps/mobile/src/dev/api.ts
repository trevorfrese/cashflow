import {
  DevAdvanceResult,
  DevClock,
  DevOverview,
  DevPersonaList,
  DevResetResult,
  DevSession,
} from '@cashflow/shared';
import type { DevAdvanceRequest } from '@cashflow/shared';

import { api } from '@/lib/api';

/**
 * The API's dev routes. They take no credentials and exist only when the API runs with
 * `ENABLE_DEV_TOOLS=true`; otherwise each call is a 404, which the menu shows as it is.
 */
export const devApi = {
  personas: () => api('/dev/personas', { schema: DevPersonaList, auth: false }),
  overview: () => api('/dev/overview', { schema: DevOverview, auth: false }),
  clock: () => api('/dev/clock', { schema: DevClock, auth: false }),
  session: (key: string) =>
    api(`/dev/personas/${encodeURIComponent(key)}/session`, {
      method: 'POST',
      schema: DevSession,
      auth: false,
    }),
  resetPersona: (key: string) =>
    api(`/dev/personas/${encodeURIComponent(key)}/reset`, {
      method: 'POST',
      schema: DevSession,
      auth: false,
    }),
  advance: (body: DevAdvanceRequest) =>
    api('/dev/clock/advance', { method: 'POST', body, schema: DevAdvanceResult, auth: false }),
  resetEverything: () => api('/dev/reset', { method: 'POST', schema: DevResetResult, auth: false }),
};
