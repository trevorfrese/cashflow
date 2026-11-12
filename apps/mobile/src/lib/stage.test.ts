import type { Lease, RentPlan, UnderwritingApplication } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { deriveStage } from './stage';

const app = (status: UnderwritingApplication['status'], createdAt = '2026-01-01T00:00:00Z') =>
  ({ id: `app-${status}-${createdAt}`, status, createdAt }) as unknown as UnderwritingApplication;
const lease = (status: Lease['status'] = 'DRAFT') => ({ id: 'lease', status }) as unknown as Lease;
const plan = (status: RentPlan['status'] = 'ACTIVE') =>
  ({ id: 'plan', status }) as unknown as RentPlan;

describe('deriveStage', () => {
  it('starts with an application', () => {
    expect(deriveStage({ applications: [], leases: [], plans: [] }).kind).toBe('NEEDS_APPLICATION');
  });

  it('follows the latest application outcome', () => {
    expect(deriveStage({ applications: [app('NEEDS_INFO')], leases: [], plans: [] }).kind).toBe(
      'NEEDS_INFO',
    );
    expect(deriveStage({ applications: [app('DECLINED')], leases: [], plans: [] }).kind).toBe(
      'DECLINED',
    );
    // A referred application is waiting on a reviewer, not approved.
    expect(deriveStage({ applications: [app('IN_REVIEW')], leases: [], plans: [] }).kind).toBe(
      'IN_REVIEW',
    );
    expect(
      deriveStage({
        applications: [
          app('DECLINED', '2026-01-01T00:00:00Z'),
          app('APPROVED', '2026-02-01T00:00:00Z'),
        ],
        leases: [],
        plans: [],
      }).kind,
    ).toBe('APPROVED_NO_LEASE');
  });

  it('moves from lease to plan', () => {
    expect(
      deriveStage({ applications: [app('APPROVED')], leases: [lease()], plans: [] }).kind,
    ).toBe('LEASE_NO_PLAN');
    expect(
      deriveStage({ applications: [app('APPROVED')], leases: [lease('ACTIVE')], plans: [plan()] })
        .kind,
    ).toBe('ACTIVE_PLAN');
  });

  it('ignores ended leases', () => {
    expect(
      deriveStage({ applications: [app('APPROVED')], leases: [lease('ENDED')], plans: [] }).kind,
    ).toBe('APPROVED_NO_LEASE');
  });

  it('shows a pass-through plan on a declined application', () => {
    const declined = app('DECLINED');
    const passThrough = {
      id: 'pt',
      status: 'ACTIVE',
      kind: 'PASS_THROUGH',
      applicationId: declined.id,
    } as unknown as RentPlan;
    const stage = deriveStage({
      applications: [declined],
      leases: [lease('ACTIVE')],
      plans: [passThrough],
    });
    expect(stage.kind).toBe('ACTIVE_PLAN');
    // A financed plan still needs an approved application.
    expect(
      deriveStage({
        applications: [declined],
        leases: [lease('ACTIVE')],
        plans: [{ ...passThrough, kind: 'FINANCED' }],
      }).kind,
    ).toBe('DECLINED');
  });
});
