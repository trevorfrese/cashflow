import {
  BankLink,
  Business,
  Installment,
  LandlordPayout,
  Lease,
  RentPlan,
  RentPlanDetail,
  Repayment,
  UnderwritingApplication,
} from '@cashflow/shared';
import type {
  CreateApplicationRequest,
  CreateBankLinkRequest,
  CreateBusinessRequest,
  CreateLeaseRequest,
  CreateRentPlanRequest,
  PayInstallmentRequest,
} from '@cashflow/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api } from './api';

/** Query keys in one place so invalidation stays consistent. */
export const keys = {
  businesses: ['businesses'] as const,
  bankLinks: (businessId: string) => ['businesses', businessId, 'bank-links'] as const,
  applications: (businessId: string) => ['businesses', businessId, 'applications'] as const,
  leases: (businessId: string) => ['businesses', businessId, 'leases'] as const,
  rentPlans: (businessId: string) => ['businesses', businessId, 'rent-plans'] as const,
  plan: (planId: string) => ['rent-plans', planId] as const,
  installments: (planId: string) => ['rent-plans', planId, 'installments'] as const,
  payouts: (planId: string) => ['rent-plans', planId, 'payouts'] as const,
  repayments: (planId: string) => ['rent-plans', planId, 'repayments'] as const,
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
    onSuccess: (link) => qc.invalidateQueries({ queryKey: keys.bankLinks(link.businessId) }),
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

export function useApplication(applicationId: string | undefined, businessId: string | undefined) {
  const list = useApplications(businessId);
  return {
    ...list,
    data: list.data?.find((a) => a.id === applicationId),
  };
}
