import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { bookProvision } from '../services/provisioning.ts';
import { runJob } from './runner.ts';

/**
 * Monthly. Sets the allowance for credit losses to what the servicing policy expects to lose
 * on outstanding receivables, by delinquency bucket, and posts only the change. Runs with
 * the other jobs every day and posts at most once per calendar month.
 */
export function provisionJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'provision', asOf, async () => {
    const result = await bookProvision(ctx, asOf);
    return { ...result };
  });
}
