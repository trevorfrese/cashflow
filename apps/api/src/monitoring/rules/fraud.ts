import { addDays, daysBetween } from '@cashflow/shared';

import { landlordIsApplicant } from '../../underwriting/integrity.ts';
import type { AlertCandidate, LeaseChangeFact, Rule } from '../types.ts';

/**
 * Fraud rules: who is being paid, and who is asking.
 *
 * These read current state. The integrity checks in `underwriting/integrity.ts` ask some of
 * the same questions once, at application; these ask them every day, because a lease, a
 * bank link, and a landlord account can all change after the decision.
 */

/** One account, however it is identified: by the provider token or by routing and last 4. */
const accountKeys = (a: { payoutToken: string; routingNumber: string; last4: string }) => [
  `token:${a.payoutToken}`,
  `account:${a.routingNumber}:${a.last4}`,
];

/** The alert for one pending change. Also used to open it the moment the change is requested. */
export function pendingLeaseChangeCandidate(
  change: LeaseChangeFact,
  proximityDays: number,
): AlertCandidate {
  const horizon = addDays(change.requestedOn, proximityDays);
  const near = change.upcomingPayouts.filter((p) => p.scheduledFor <= horizon);
  const next = near[0] ?? null;
  return {
    type: 'fraud.landlord_change_pending',
    category: 'FRAUD',
    // A payout about to go out is what a takeover is after. Without one it is still a
    // change to who gets paid, and still someone's to look at.
    severity: next ? 'HIGH' : 'WARNING',
    subjectType: 'lease',
    subjectId: change.leaseId,
    title: next
      ? `Landlord details changed ${beforePayout(daysBetween(change.requestedOn, next.scheduledFor))}: ${change.businessName}`
      : `Landlord details change pending: ${change.businessName}`,
    detail: {
      leaseChangeId: change.id,
      businessId: change.businessId,
      fields: change.fields,
      requestedOn: change.requestedOn,
      effectiveOn: change.effectiveOn,
      payouts: near,
      heldPayouts: near.filter((p) => p.status === 'HELD').length,
    },
    dedupeKey: `lease_change:${change.id}`,
  };
}

export const landlordChangePending: Rule = {
  type: 'fraud.landlord_change_pending',
  category: 'FRAUD',
  description:
    'A change to a landlord or payout account is inside its cooling-off period. High when a payout on the lease is held or falls due within the proximity window of the request.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) =>
    inputs.leaseChanges
      .filter((c) => c.status === 'PENDING')
      .map((c) => pendingLeaseChangeCandidate(c, policy.fraud.payoutProximityDays)),
};

export const landlordChangeBeforePayout: Rule = {
  type: 'fraud.landlord_change_before_payout',
  category: 'FRAUD',
  description:
    'A change to a landlord or payout account took effect shortly before a payout that has not gone out yet. Clears once the payout is paid or the window passes.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const out: AlertCandidate[] = [];
    for (const c of inputs.leaseChanges) {
      if (c.status !== 'APPLIED' || c.appliedOn === null) continue;
      const horizon = addDays(c.appliedOn, policy.fraud.payoutProximityDays);
      const next = c.upcomingPayouts.find(
        (p) => p.scheduledFor >= c.appliedOn! && p.scheduledFor <= horizon,
      );
      if (!next || inputs.asOf > horizon) continue;
      out.push({
        type: 'fraud.landlord_change_before_payout',
        category: 'FRAUD',
        severity: 'WARNING',
        subjectType: 'lease',
        subjectId: c.leaseId,
        title: `First payout to changed landlord details is due ${next.scheduledFor}: ${c.businessName}`,
        detail: {
          leaseChangeId: c.id,
          businessId: c.businessId,
          fields: c.fields,
          appliedOn: c.appliedOn,
          approvedEarlyBy: c.approvedBy,
          payout: next,
        },
        dedupeKey: `lease_change_applied:${c.id}`,
      });
    }
    return out;
  },
};

export const landlordIsBorrowerAccount: Rule = {
  type: 'fraud.landlord_is_borrower_account',
  category: 'FRAUD',
  description:
    'A landlord payout account is a bank account a borrower has linked: the same provider token as any linked account, or the same last 4 digits as the business own account with the business as the account holder. Rent paid there is a cash advance.',
  // Money may already have gone there. A person closes this, not a later edit to the lease.
  autoResolves: false,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) => {
    const out: AlertCandidate[] = [];
    const byToken = new Map<string, (typeof inputs.bankAccounts)[number][]>();
    for (const b of inputs.bankAccounts) {
      byToken.set(b.accountToken, [...(byToken.get(b.accountToken) ?? []), b]);
    }
    for (const lease of inputs.landlordAccounts) {
      const sameToken = byToken.get(lease.payoutToken) ?? [];
      const own = inputs.bankAccounts.filter((b) => b.businessId === lease.businessId);
      const ownMatch =
        own.length > 0 &&
        landlordIsApplicant(
          {
            landlordPayoutToken: lease.payoutToken,
            landlordAccountNumberLast4: lease.last4,
            landlordAccountHolderName: lease.holderName,
          },
          own.map((b) => ({ providerAccountToken: b.accountToken, accountMask: b.mask })),
          { legalName: own[0]!.businessName, dba: own[0]!.dba },
        );
      if (sameToken.length === 0 && !ownMatch) continue;
      out.push({
        type: 'fraud.landlord_is_borrower_account',
        category: 'FRAUD',
        severity: 'CRITICAL',
        subjectType: 'lease',
        subjectId: lease.leaseId,
        title: `Landlord payout account is a borrower's bank account: ${lease.businessName}`,
        detail: {
          businessId: lease.businessId,
          landlordName: lease.landlordName,
          hasOpenPlan: lease.hasOpenPlan,
          matchesOwnAccount: ownMatch,
          matchingBankLinks: sameToken.map((b) => ({
            bankLinkId: b.bankLinkId,
            businessId: b.businessId,
            businessName: b.businessName,
          })),
        },
        dedupeKey: `landlord_is_borrower:${lease.leaseId}`,
      });
    }
    return out;
  },
};

export const sharedLandlordAccount: Rule = {
  type: 'fraud.shared_landlord_account',
  category: 'FRAUD',
  description:
    'One landlord payout account (same token, or same routing number and last 4) is paid by businesses under several different users. A landlord with several tenants is normal; past the threshold it can be one person collecting rent advances through shell tenants.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const groups = new Map<string, typeof inputs.landlordAccounts>();
    for (const lease of inputs.landlordAccounts) {
      for (const key of accountKeys(lease)) {
        groups.set(key, [...(groups.get(key) ?? []), lease]);
      }
    }
    const seen = new Set<string>();
    const out: AlertCandidate[] = [];
    for (const [key, leases] of groups) {
      const users = new Set(leases.map((l) => l.ownerUserId));
      if (users.size < policy.fraud.sharedLandlordWarnUsers) continue;
      // The same set of leases found by token and again by account number is one alert.
      const signature = leases
        .map((l) => l.leaseId)
        .sort()
        .join(',');
      if (seen.has(signature)) continue;
      seen.add(signature);
      const sample = leases[0]!;
      out.push({
        type: 'fraud.shared_landlord_account',
        category: 'FRAUD',
        severity: users.size >= policy.fraud.sharedLandlordHighUsers ? 'HIGH' : 'WARNING',
        subjectType: 'landlord_account',
        subjectId: `${sample.routingNumber}:${sample.last4}`,
        title: `${users.size} unrelated users pay the same landlord account (ending ${sample.last4})`,
        detail: {
          matchedBy: key.startsWith('token:') ? 'payout token' : 'routing number and last 4',
          users: users.size,
          businesses: new Set(leases.map((l) => l.businessId)).size,
          leases: leases.map((l) => ({
            leaseId: l.leaseId,
            businessId: l.businessId,
            businessName: l.businessName,
            landlordName: l.landlordName,
          })),
        },
        dedupeKey: `shared_landlord:${sample.routingNumber}:${sample.last4}`,
      });
    }
    return out;
  },
};

export const sharedBankAccount: Rule = {
  type: 'fraud.shared_bank_account',
  category: 'FRAUD',
  description:
    'One bank account is linked by more than one business. Under different users it is high: one business applying twice, or a mule account. Under one user it is informational: an owner running two businesses out of one account.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) => {
    const groups = new Map<string, typeof inputs.bankAccounts>();
    for (const b of inputs.bankAccounts) {
      groups.set(b.accountToken, [...(groups.get(b.accountToken) ?? []), b]);
    }
    const out: AlertCandidate[] = [];
    for (const [, links] of groups) {
      const businesses = new Set(links.map((l) => l.businessId));
      if (businesses.size < 2) continue;
      const users = new Set(links.map((l) => l.ownerUserId));
      const first = [...links].sort((a, b) => (a.bankLinkId < b.bankLinkId ? -1 : 1))[0]!;
      out.push({
        type: 'fraud.shared_bank_account',
        category: 'FRAUD',
        severity: users.size > 1 ? 'HIGH' : 'INFO',
        subjectType: 'bank_account',
        subjectId: first.bankLinkId,
        title:
          users.size > 1
            ? `One bank account (ending ${first.mask}) is linked by ${users.size} different users`
            : `One bank account (ending ${first.mask}) is linked by ${businesses.size} businesses of one user`,
        detail: {
          users: users.size,
          businesses: links.map((l) => ({
            bankLinkId: l.bankLinkId,
            businessId: l.businessId,
            businessName: l.businessName,
            ownerUserId: l.ownerUserId,
          })),
        },
        dedupeKey: `shared_bank:${first.bankLinkId}`,
      });
    }
    return out;
  },
};

export const applicationVelocity: Rule = {
  type: 'fraud.application_velocity',
  category: 'FRAUD',
  description: 'One user created an unusual number of applications inside the velocity window.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const from = addDays(inputs.asOf, -(policy.fraud.velocityWindowDays - 1));
    const byUser = new Map<string, typeof inputs.applications>();
    for (const a of inputs.applications) {
      if (a.createdOn < from || a.createdOn > inputs.asOf) continue;
      byUser.set(a.ownerUserId, [...(byUser.get(a.ownerUserId) ?? []), a]);
    }
    const out: AlertCandidate[] = [];
    for (const [userId, apps] of byUser) {
      if (apps.length < policy.fraud.velocityWarnApplications) continue;
      out.push({
        type: 'fraud.application_velocity',
        category: 'FRAUD',
        severity: apps.length >= policy.fraud.velocityHighApplications ? 'HIGH' : 'WARNING',
        subjectType: 'user',
        subjectId: userId,
        title: `${apps.length} applications from one user in ${policy.fraud.velocityWindowDays} days`,
        detail: {
          windowDays: policy.fraud.velocityWindowDays,
          applications: apps.map((a) => ({
            applicationId: a.id,
            businessId: a.businessId,
            businessName: a.businessName,
            status: a.status,
            createdOn: a.createdOn,
          })),
        },
        dedupeKey: `velocity:${userId}`,
      });
    }
    return out;
  },
};

export const reapplyAfterDecline: Rule = {
  type: 'fraud.reapply_after_decline',
  category: 'FRAUD',
  description:
    'A user whose application was declined has created further applications inside the reapply window.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const from = addDays(inputs.asOf, -(policy.fraud.reapplyWindowDays - 1));
    const byUser = new Map<string, typeof inputs.applications>();
    for (const a of inputs.applications) {
      byUser.set(a.ownerUserId, [...(byUser.get(a.ownerUserId) ?? []), a]);
    }
    const out: AlertCandidate[] = [];
    for (const [userId, apps] of byUser) {
      const declines = apps
        .filter((a) => a.declinedOn !== null && a.declinedOn >= from)
        .sort((a, b) => (a.declinedOn! < b.declinedOn! ? -1 : 1));
      const first = declines[0];
      if (!first) continue;
      const after = apps.filter(
        (a) => a.id !== first.id && a.createdOn >= first.declinedOn! && a.createdOn <= inputs.asOf,
      );
      if (after.length < policy.fraud.reapplyWarnApplications) continue;
      out.push({
        type: 'fraud.reapply_after_decline',
        category: 'FRAUD',
        severity: 'WARNING',
        subjectType: 'user',
        subjectId: userId,
        title: `${after.length} applications after a decline within ${policy.fraud.reapplyWindowDays} days`,
        detail: {
          declinedApplicationId: first.id,
          declinedOn: first.declinedOn,
          applicationsAfter: after.map((a) => ({
            applicationId: a.id,
            businessName: a.businessName,
            status: a.status,
            createdOn: a.createdOn,
          })),
        },
        dedupeKey: `reapply:${userId}`,
      });
    }
    return out;
  },
};

export const screeningHit: Rule = {
  type: 'fraud.screening_hit',
  category: 'FRAUD',
  description:
    'A business, an owner, or a landlord has a current sanctions or watchlist hit that nobody has cleared. Clears when a reviewer clears the hit or a later screening replaces it.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.screenings
      .filter((s) => s.result !== 'CLEAR' && !s.cleared)
      .map((s) => ({
        type: 'fraud.screening_hit',
        category: 'FRAUD' as const,
        severity: s.result === 'MATCH' ? ('CRITICAL' as const) : ('HIGH' as const),
        subjectType: 'screening',
        subjectId: s.id,
        title: `${s.result === 'MATCH' ? 'Match' : 'Possible match'} on a ${
          s.leaseChangeId ? 'proposed landlord' : s.partyType.toLowerCase()
        }: ${s.businessName}`,
        detail: {
          screeningId: s.id,
          businessId: s.businessId,
          partyType: s.partyType,
          partyRef: s.partyRef,
          result: s.result,
          screenedOn: s.screenedOn,
          leaseChangeId: s.leaseChangeId,
          tiedToOpenPlan: s.activeParty,
        },
        dedupeKey: `screening_hit:${s.id}`,
      })),
};

export const FRAUD_RULES: Rule[] = [
  landlordChangePending,
  landlordChangeBeforePayout,
  landlordIsBorrowerAccount,
  sharedLandlordAccount,
  sharedBankAccount,
  applicationVelocity,
  reapplyAfterDecline,
  screeningHit,
];

/** "on the day of a payout", "1 day before a payout", "3 days before a payout". */
function beforePayout(days: number): string {
  if (days <= 0) return 'on the day of a payout';
  return `${days} ${days === 1 ? 'day' : 'days'} before a payout`;
}
