import {
  BankLink,
  Business,
  Connection,
  ConnectionList,
  MockAuthorizeResponse,
  SeatInvitation,
  StartOAuthResponse,
  Installment,
  LandlordPayout,
  GraduationOffer,
  Lease,
  PassThroughOffer,
  PaymentHistory,
  RentPlan,
  RentPlanDetail,
  Repayment,
  UnderwritingApplication,
} from '@cashflow/shared';
import type {
  CommercePlatform,
  CreateApplicationRequest,
  CreateBankLinkRequest,
  CreateBusinessRequest,
  CreateLeaseRequest,
  CreateRentPlanRequest,
  PayInstallmentRequest,
  StartPassThroughPlanRequest,
  UpdateRentPlanRequest,
} from '@cashflow/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api } from './api';
import { redirectParams } from './connections';

/** Query keys in one place so invalidation stays consistent. */
export const keys = {
  businesses: ['businesses'] as const,
  bankLinks: (businessId: string) => ['businesses', businessId, 'bank-links'] as const,
  connections: (businessId: string) => ['businesses', businessId, 'connections'] as const,
  applications: (businessId: string) => ['businesses', businessId, 'applications'] as const,
  leases: (businessId: string) => ['businesses', businessId, 'leases'] as const,
  rentPlans: (businessId: string) => ['businesses', businessId, 'rent-plans'] as const,
  plan: (planId: string) => ['rent-plans', planId] as const,
  installments: (planId: string) => ['rent-plans', planId, 'installments'] as const,
  payouts: (planId: string) => ['rent-plans', planId, 'payouts'] as const,
  repayments: (planId: string) => ['rent-plans', planId, 'repayments'] as const,
  passThroughOffer: (applicationId: string) =>
    ['applications', applicationId, 'pass-through'] as const,
  paymentHistory: (businessId: string) => ['businesses', businessId, 'payment-history'] as const,
};

export function useBusinesses(enabled = true) {
  return useQuery({
    queryKey: keys.businesses,
    queryFn: () => api('/businesses', { schema: z.array(Business) }),
    enabled,
  });
}

export function useCreateBusiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBusinessRequest) =>
      api('/businesses', { method: 'POST', body, schema: Business }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.businesses }),
  });
}

export function useBankLinks(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.bankLinks(businessId ?? ''),
    queryFn: () => api(`/businesses/${businessId}/bank-links`, { schema: z.array(BankLink) }),
    enabled: Boolean(businessId),
  });
}

export function useCreateBankLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateBankLinkRequest) => {
      // Mirrors a real Plaid flow: ask for a link token first, then exchange the public token.
      await api('/bank-links/link-token', {
        method: 'POST',
        body: { businessId: body.businessId },
        schema: z.object({ linkToken: z.string(), provider: z.string() }),
      });
      return api('/bank-links', { method: 'POST', body, schema: BankLink });
    },
    onSuccess: (link) => {
      void qc.invalidateQueries({ queryKey: keys.bankLinks(link.businessId) });
      void qc.invalidateQueries({ queryKey: keys.connections(link.businessId) });
    },
  });
}

export function useApplications(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.applications(businessId ?? ''),
    queryFn: () =>
      api(`/businesses/${businessId}/applications`, {
        schema: z.array(UnderwritingApplication),
      }),
    enabled: Boolean(businessId),
  });
}

export function useSubmitApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateApplicationRequest) => {
      const created = await api('/underwriting/applications', {
        method: 'POST',
        body,
        schema: UnderwritingApplication,
      });
      return api(`/underwriting/applications/${created.id}/submit`, {
        method: 'POST',
        body: body.bankLinkId ? { bankLinkId: body.bankLinkId } : undefined,
        schema: UnderwritingApplication,
      });
    },
    onSuccess: (app) => {
      void qc.invalidateQueries({ queryKey: keys.applications(app.businessId) });
      void qc.invalidateQueries({ queryKey: keys.businesses });
    },
  });
}

export function useLeases(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.leases(businessId ?? ''),
    queryFn: () => api(`/businesses/${businessId}/leases`, { schema: z.array(Lease) }),
    enabled: Boolean(businessId),
  });
}

export function useCreateLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLeaseRequest) =>
      api('/leases', { method: 'POST', body, schema: Lease }),
    onSuccess: (lease) => qc.invalidateQueries({ queryKey: keys.leases(lease.businessId) }),
  });
}

export function useRentPlans(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.rentPlans(businessId ?? ''),
    queryFn: () => api(`/businesses/${businessId}/rent-plans`, { schema: z.array(RentPlan) }),
    enabled: Boolean(businessId),
  });
}

export function useCreateRentPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRentPlanRequest) =>
      api('/rent-plans', { method: 'POST', body, schema: RentPlan }),
    onSuccess: (plan) => {
      void qc.invalidateQueries({ queryKey: keys.rentPlans(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.leases(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.businesses });
    },
  });
}

export function useUpdateRentPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, ...body }: UpdateRentPlanRequest & { planId: string }) =>
      api(`/rent-plans/${planId}`, { method: 'PATCH', body, schema: RentPlan }),
    onSuccess: (plan) => {
      void qc.invalidateQueries({ queryKey: keys.rentPlans(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.plan(plan.id) });
    },
  });
}

export function useRentPlan(planId: string | undefined) {
  return useQuery({
    queryKey: keys.plan(planId ?? ''),
    queryFn: () => api(`/rent-plans/${planId}`, { schema: RentPlanDetail }),
    enabled: Boolean(planId),
  });
}

export function useInstallments(planId: string | undefined) {
  return useQuery({
    queryKey: keys.installments(planId ?? ''),
    queryFn: () => api(`/rent-plans/${planId}/installments`, { schema: z.array(Installment) }),
    enabled: Boolean(planId),
  });
}

export function usePayouts(planId: string | undefined) {
  return useQuery({
    queryKey: keys.payouts(planId ?? ''),
    queryFn: () => api(`/rent-plans/${planId}/payouts`, { schema: z.array(LandlordPayout) }),
    enabled: Boolean(planId),
  });
}

export function useRepayments(planId: string | undefined) {
  return useQuery({
    queryKey: keys.repayments(planId ?? ''),
    queryFn: () => api(`/rent-plans/${planId}/repayments`, { schema: z.array(Repayment) }),
    enabled: Boolean(planId),
  });
}

export function usePayInstallment(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PayInstallmentRequest) =>
      api('/repayments', { method: 'POST', body, schema: Installment }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['rent-plans', planId] }),
  });
}

/** Re-run underwriting on an application that needs info, optionally with a new bank link. */
export function useResubmitApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { applicationId: string; bankLinkId?: string }) =>
      api(`/underwriting/applications/${input.applicationId}/submit`, {
        method: 'POST',
        body: input.bankLinkId ? { bankLinkId: input.bankLinkId } : undefined,
        schema: UnderwritingApplication,
      }),
    onSuccess: (app) => {
      void qc.invalidateQueries({ queryKey: keys.applications(app.businessId) });
      void qc.invalidateQueries({ queryKey: keys.businesses });
    },
  });
}

// ---------- Pass-through plan and graduation ----------

/** The free pass-through offer on a declined application. */
export function usePassThroughOffer(applicationId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.passThroughOffer(applicationId ?? ''),
    queryFn: () =>
      api(`/underwriting/applications/${applicationId}/pass-through`, {
        schema: PassThroughOffer,
      }),
    enabled: Boolean(applicationId) && enabled,
  });
}

export function useStartPassThroughPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartPassThroughPlanRequest) =>
      api('/pass-through-plans', { method: 'POST', body, schema: RentPlan }),
    onSuccess: (plan) => {
      void qc.invalidateQueries({ queryKey: keys.rentPlans(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.leases(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.paymentHistory(plan.businessId) });
      void qc.invalidateQueries({ queryKey: keys.passThroughOffer(plan.applicationId) });
      void qc.invalidateQueries({ queryKey: keys.businesses });
    },
  });
}

export function usePaymentHistory(businessId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.paymentHistory(businessId ?? ''),
    queryFn: () => api(`/businesses/${businessId}/payment-history`, { schema: PaymentHistory }),
    enabled: Boolean(businessId) && enabled,
  });
}

export function useAcceptGraduationOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) =>
      api(`/graduation-offers/${offerId}/accept`, {
        method: 'POST',
        body: {},
        schema: GraduationOffer,
      }),
    onSuccess: (offer) => {
      void qc.invalidateQueries({ queryKey: keys.plan(offer.passThroughPlanId) });
      void qc.invalidateQueries({ queryKey: keys.paymentHistory(offer.businessId) });
      void qc.invalidateQueries({ queryKey: keys.rentPlans(offer.businessId) });
      void qc.invalidateQueries({ queryKey: keys.applications(offer.businessId) });
    },
  });
}

export function useApplication(applicationId: string | undefined, businessId: string | undefined) {
  const list = useApplications(businessId);
  return {
    ...list,
    data: list.data?.find((a) => a.id === applicationId),
  };
}

// ---------- Data connections ----------

export function useConnections(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.connections(businessId ?? ''),
    queryFn: () => api(`/businesses/${businessId}/connections`, { schema: ConnectionList }),
    enabled: Boolean(businessId),
  });
}

/** Where to send the owner to approve read-only access on the platform's own site. */
export function useStartOAuth() {
  return useMutation({
    mutationFn: (body: { businessId: string; platform: CommercePlatform; redirectUri?: string }) =>
      api('/connections/oauth/start', { method: 'POST', body, schema: StartOAuthResponse }),
  });
}

/**
 * The sandbox stand-in for the platform's consent page, then the redirect back: exactly the
 * two requests a real round trip makes, without a browser.
 */
export function useApproveSandboxOAuth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { state: string; scenario: string; approve: boolean }) => {
      const page = await api('/connections/oauth/mock-authorize', {
        method: 'POST',
        body: input,
        schema: MockAuthorizeResponse,
      });
      const redirect = redirectParams(page.redirectUrl);
      return api('/connections/oauth/callback', {
        method: 'POST',
        body: {
          state: redirect.state ?? input.state,
          ...(redirect.code ? { code: redirect.code } : {}),
          ...(redirect.error ? { error: redirect.error } : {}),
        },
        schema: Connection,
      });
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: keys.connections(c.businessId) });
    },
  });
}

export function useCreateSeatInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { businessId: string; platform: CommercePlatform; scenario?: string }) =>
      api('/connections/seats', { method: 'POST', body, schema: SeatInvitation }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: keys.connections(s.connection.businessId) });
    },
  });
}

export function useVerifySeat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api(`/connections/${connectionId}/verify-seat`, { method: 'POST', schema: Connection }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: keys.connections(c.businessId) });
    },
  });
}

export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api(`/connections/${connectionId}/disconnect`, { method: 'POST', schema: Connection }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: keys.connections(c.businessId) });
      void qc.invalidateQueries({ queryKey: keys.bankLinks(c.businessId) });
    },
  });
}
