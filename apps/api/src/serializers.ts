import type {
  BankLink as BankLinkDto,
  Business as BusinessDto,
  CommerceLink as CommerceLinkDto,
  Installment as InstallmentDto,
  LandlordPayout as PayoutDto,
  Lease as LeaseDto,
  RentPlan as RentPlanDto,
  Repayment as RepaymentDto,
  UnderwritingApplication as ApplicationDto,
  UnderwritingDecision as DecisionDto,
  User as UserDto,
} from '@cashflow/shared';

import type {
  BankLink,
  Business,
  CommerceLink,
  Installment,
  LandlordPayout,
  Lease,
  RentPlan,
  Repayment,
  UnderwritingApplication,
  UnderwritingDecision,
  User,
} from './generated/prisma/client.ts';

const iso = (d: Date) => d.toISOString();

export const toUser = (u: User): UserDto => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  createdAt: iso(u.createdAt),
});

export const toBusiness = (b: Business): BusinessDto => ({
  id: b.id,
  ownerUserId: b.ownerUserId,
  legalName: b.legalName,
  dba: b.dba ?? undefined,
  industry: b.industry,
  address: {
    line1: b.addressLine1,
    line2: b.addressLine2 ?? undefined,
    city: b.city,
    state: b.state,
    postalCode: b.postalCode,
  },
  foundedOn: b.foundedOn,
  statedMonthlyRevenueCents: b.statedMonthlyRevenueCents,
  status: b.status,
  createdAt: iso(b.createdAt),
  updatedAt: iso(b.updatedAt),
});

export const toBankLink = (l: BankLink): BankLinkDto => ({
  id: l.id,
  businessId: l.businessId,
  provider: l.provider,
  institutionName: l.institutionName,
  accountMask: l.accountMask,
  status: l.status,
  availableBalanceCents: l.availableBalanceCents,
  createdAt: iso(l.createdAt),
});

export const toCommerceLink = (l: CommerceLink): CommerceLinkDto => ({
  id: l.id,
  businessId: l.businessId,
  provider: l.provider,
  platform: l.platform,
  locationName: l.locationName,
  status: l.status,
  connectedSince: l.connectedSince,
  createdAt: iso(l.createdAt),
});

export const toDecision = (d: UnderwritingDecision): DecisionDto => ({
  id: d.id,
  applicationId: d.applicationId,
  outcome: d.outcome,
  approvedMonthlyLimitCents: d.approvedMonthlyLimitCents,
  feeBps: d.feeBps,
  score: d.score,
  grade: (d.grade as DecisionDto['grade']) ?? null,
  recommendedInstallmentsPerMonth: d.recommendedInstallmentsPerMonth,
  reasons: (d.reasons as DecisionDto['reasons']) ?? [],
  cashFlow: (d.cashFlow as DecisionDto['cashFlow']) ?? null,
  provider: d.provider,
  decidedAt: iso(d.decidedAt),
});

export const toApplication = (
  a: UnderwritingApplication & { decision: UnderwritingDecision | null },
): ApplicationDto => ({
  id: a.id,
  businessId: a.businessId,
  bankLinkId: a.bankLinkId ?? undefined,
  commerceLinkId: a.commerceLinkId ?? undefined,
  statedMonthlyRevenueCents: a.statedMonthlyRevenueCents,
  timeInBusinessMonths: a.timeInBusinessMonths,
  requestedMonthlyRentCents: a.requestedMonthlyRentCents,
  status: a.status,
  submittedAt: a.submittedAt ? iso(a.submittedAt) : null,
  decision: a.decision ? toDecision(a.decision) : null,
  createdAt: iso(a.createdAt),
  updatedAt: iso(a.updatedAt),
});

export const toLease = (l: Lease): LeaseDto => ({
  id: l.id,
  businessId: l.businessId,
  landlordName: l.landlordName,
  landlordEmail: l.landlordEmail,
  propertyAddress: {
    line1: l.propertyLine1,
    line2: l.propertyLine2 ?? undefined,
    city: l.propertyCity,
    state: l.propertyState,
    postalCode: l.propertyPostalCode,
  },
  monthlyRentCents: l.monthlyRentCents,
  dueDayOfMonth: l.dueDayOfMonth,
  startsOn: l.startsOn,
  endsOn: l.endsOn,
  status: l.status,
  landlordPayout: {
    accountHolderName: l.landlordAccountHolderName,
    routingNumber: l.landlordRoutingNumber,
    accountNumberLast4: l.landlordAccountNumberLast4,
  },
  createdAt: iso(l.createdAt),
  updatedAt: iso(l.updatedAt),
});

export const toRentPlan = (p: RentPlan): RentPlanDto => ({
  id: p.id,
  businessId: p.businessId,
  leaseId: p.leaseId,
  applicationId: p.applicationId,
  installmentsPerMonth: p.installmentsPerMonth,
  feeBps: p.feeBps,
  monthlyRentCents: p.monthlyRentCents,
  dueDayOfMonth: p.dueDayOfMonth,
  status: p.status,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

export const toPayout = (p: LandlordPayout): PayoutDto => ({
  id: p.id,
  rentPlanId: p.rentPlanId,
  periodMonth: p.periodMonth,
  amountCents: p.amountCents,
  scheduledFor: p.scheduledFor,
  status: p.status,
  paidAt: p.paidAt ? iso(p.paidAt) : null,
  providerRef: p.providerRef,
  failureReason: p.failureReason,
});

export const toInstallment = (i: Installment): InstallmentDto => ({
  id: i.id,
  rentPlanId: i.rentPlanId,
  payoutId: i.payoutId,
  periodMonth: i.periodMonth,
  sequence: i.sequence,
  principalCents: i.principalCents,
  feeCents: i.feeCents,
  totalCents: i.totalCents,
  dueDate: i.dueDate,
  status: i.status,
  paidAt: i.paidAt ? iso(i.paidAt) : null,
});

export const toRepayment = (r: Repayment): RepaymentDto => ({
  id: r.id,
  installmentId: r.installmentId,
  amountCents: r.amountCents,
  provider: r.provider,
  providerRef: r.providerRef,
  status: r.status,
  failureReason: r.failureReason,
  createdAt: iso(r.createdAt),
});
