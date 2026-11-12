import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { sweepAdverseActionNotices } from '../services/adverse-action.ts';
import { runJob } from './runner.ts';

/**
 * Adverse action notices that fall due on a date rather than with a decision: a counter
 * offer that expired without a plan opened on it, a notice of incompleteness for an
 * application left waiting on information, and the notice that closes it when it stays
 * incomplete. Also stores a notice, marked late, for any decline that has none.
 *
 * Idempotent: one notice per decision and kind, so a second run on the same day stores
 * nothing.
 */
export function adverseActionNoticesJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'adverse-action-notices', asOf, () => sweepAdverseActionNotices(ctx.db, asOf));
}
