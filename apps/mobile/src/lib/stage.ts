import type { Lease, RentPlan, UnderwritingApplication } from '@cashflow/shared';

/**
 * Where a business is in the CashFlow journey, derived from the server's records. The home
 * screen uses this to show the one next step instead of a menu of everything.
 */
export type Stage =
  | { kind: 'NEEDS_APPLICATION' }
  | { kind: 'NEEDS_INFO'; application: UnderwritingApplication }
  | { kind: 'IN_REVIEW'; application: UnderwritingApplication }
  | { kind: 'DECLINED'; application: UnderwritingApplication }
  | { kind: 'APPROVED_NO_LEASE'; application: UnderwritingApplication }
  | { kind: 'LEASE_NO_PLAN'; application: UnderwritingApplication; lease: Lease }
  | { kind: 'ACTIVE_PLAN'; application: UnderwritingApplication; plan: RentPlan };

export function deriveStage(input: {
  applications: UnderwritingApplication[];
  leases: Lease[];
  plans: RentPlan[];
}): Stage {
  const activePlan = input.plans.find((p) => p.status === 'ACTIVE') ?? input.plans[0];
  const approved = latest(input.applications.filter((a) => a.status === 'APPROVED'));
  if (activePlan && approved)
    return { kind: 'ACTIVE_PLAN', application: approved, plan: activePlan };

  const current = latest(input.applications);
  if (!current || current.status === 'DRAFT') return { kind: 'NEEDS_APPLICATION' };
  if (current.status === 'NEEDS_INFO') return { kind: 'NEEDS_INFO', application: current };
  if (current.status === 'IN_REVIEW') return { kind: 'IN_REVIEW', application: current };
  if (current.status === 'DECLINED') return { kind: 'DECLINED', application: current };
  if (current.status === 'SUBMITTED') return { kind: 'NEEDS_APPLICATION' };

  const lease = input.leases.find((l) => l.status !== 'ENDED');
  if (!lease) return { kind: 'APPROVED_NO_LEASE', application: current };
  return { kind: 'LEASE_NO_PLAN', application: current, lease };
}

function latest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}
