import type { Tx } from '../db.ts';
import type {
  Prisma,
  UnderwritingApplication,
  UnderwritingDecision,
} from '../generated/prisma/client.ts';

/**
 * Decisions are append-only. An application can have many: the engine's first answer, a
 * resubmission after more information, a reviewer's outcome, and monthly periodic reviews
 * once a plan is running. Nothing is deleted. A new origination decision sets `supersededAt`
 * on the one before it.
 *
 * "The decision" an applicant sees, a plan is priced from, and a limit is read from is
 * always the current origination decision: not superseded, and not a periodic review.
 * Everything that reads a decision goes through this module so that rule lives in one place.
 */
export const CURRENT_DECISION = {
  supersededAt: null,
  kind: { not: 'PERIODIC_REVIEW' },
} as const satisfies Prisma.UnderwritingDecisionWhereInput;

/** `include` fragment that loads only the current decision, as a zero or one element list. */
export const INCLUDE_CURRENT_DECISION = {
  decisions: { where: CURRENT_DECISION, orderBy: { decidedAt: 'desc' }, take: 1 },
} as const satisfies Prisma.UnderwritingApplicationInclude;

export type ApplicationWithDecisions = UnderwritingApplication & {
  decisions: UnderwritingDecision[];
};
export type ApplicationWithDecision = UnderwritingApplication & {
  decision: UnderwritingDecision | null;
};

/** Collapse the list loaded by `INCLUDE_CURRENT_DECISION` into a single `decision`. */
export function withCurrentDecision<T extends ApplicationWithDecisions>(
  application: T,
): Omit<T, 'decisions'> & { decision: UnderwritingDecision | null } {
  const { decisions, ...rest } = application;
  return { ...rest, decision: decisions[0] ?? null };
}

export function currentDecision(tx: Tx, applicationId: string) {
  return tx.underwritingDecision.findFirst({
    where: { applicationId, ...CURRENT_DECISION },
    orderBy: { decidedAt: 'desc' },
  });
}

/** Mark the current origination decision as replaced. Returns its id, if there was one. */
export async function supersedeCurrentDecision(
  tx: Tx,
  applicationId: string,
  at: Date = new Date(),
): Promise<string | null> {
  const current = await currentDecision(tx, applicationId);
  if (!current) return null;
  await tx.underwritingDecision.update({
    where: { id: current.id },
    data: { supersededAt: at },
  });
  return current.id;
}

/** Every decision on an application, oldest first, including superseded and periodic ones. */
export function decisionHistory(tx: Tx, applicationId: string) {
  return tx.underwritingDecision.findMany({
    where: { applicationId },
    orderBy: { decidedAt: 'asc' },
  });
}
