import { formatBps } from '@cashflow/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, EmptyState, Notice, Pill, Screen, Segmented, Text, Toggle } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatMoney, ordinal } from '@/lib/forms';
import { useLeases, useRentPlans, useUpdateRentPlan } from '@/lib/queries';
import { spacing } from '@/theme';

const CADENCES = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
] as const;

/** The BNPL controls for the selected business: how often to repay, and pause or resume. */
export default function RentSettings() {
  const { business } = useBusiness();
  const leases = useLeases(business?.id);
  const plans = useRentPlans(business?.id);
  const update = useUpdateRentPlan();
  const [error, setError] = useState<string | null>(null);
  const plan = plans.data?.find((p) => p.status !== 'CLOSED') ?? null;
  const lease = leases.data?.find((l) => l.id === plan?.leaseId) ?? null;

  if (plans.error ?? leases.error) {
    return (
      <Screen back title="Rent">
        <Notice tone="danger" message={describeError(plans.error ?? leases.error)} />
      </Screen>
    );
  }
  if (!plans.isLoading && !leases.isLoading && (!plan || !lease)) {
    return (
      <Screen back title="Rent">
        {plans.data?.some((p) => p.status === 'CLOSED') ? (
          <EmptyState
            title="Your plan is closed"
            message="We no longer pay rent on this plan, so there is nothing to set here. Anything still owed is on the home screen."
          />
        ) : (
          <EmptyState
            title="No rent plan yet"
            message={`${business?.dba ?? business?.legalName ?? 'This business'} is not splitting rent yet. Start from the home screen.`}
          />
        )}
      </Screen>
    );
  }
  if (!plan || !lease) {
    return (
      <Screen back title="Rent">
        <Text tone="muted">Loading…</Text>
      </Screen>
    );
  }

  const change = async (body: { installmentsPerMonth?: number; status?: 'ACTIVE' | 'PAUSED' }) => {
    setError(null);
    try {
      await update.mutateAsync({ planId: plan.id, ...body });
    } catch (e) {
      setError(describeError(e));
    }
  };
  const paused = plan.status === 'PAUSED';

  if (plan.kind === 'PASS_THROUGH') {
    return (
      <Screen back title="Rent" subtitle={business?.dba ?? business?.legalName}>
        <Card tone="gold">
          <Text variant="label">Free pass-through plan</Text>
          <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
            {formatMoney(plan.monthlyRentCents)}
          </Text>
          <Text variant="body">
            {`To ${lease.landlordName} on the ${ordinal(plan.dueDayOfMonth)}. No fee.`}
          </Text>
        </Card>
        <Text variant="body" tone="muted">
          We collect your rent from your bank a few business days before it is due and pay your
          landlord on the due date. There is nothing to set here.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen back title="Rent" subtitle={business?.dba ?? business?.legalName}>
      {error ? <Notice tone="danger" message={error} /> : null}
      <Card tone="gold">
        <View style={styles.rowBetween}>
          <Text variant="label" style={styles.shrink}>
            Monthly rent
          </Text>
          <Pill label={paused ? 'Paused' : 'Active'} tone={paused ? 'due' : 'paid'} />
        </View>
        <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
          {formatMoney(plan.monthlyRentCents)}
        </Text>
        <Text variant="body">
          {`To ${lease.landlordName} on the ${ordinal(plan.dueDayOfMonth)}. ${formatBps(plan.feeBps)} fee.`}
        </Text>
      </Card>

      <Card>
        <Text variant="heading">Payments a month</Text>
        <Segmented
          options={CADENCES}
          value={plan.installmentsPerMonth}
          onChange={(v) => void change({ installmentsPerMonth: v })}
        />
        <Text variant="caption" tone="muted">
          Applies from next month. Two a month is the 1st and the 15th.
        </Text>
      </Card>

      <Card>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="heading">Pause rent splitting</Text>
            <Text variant="caption" tone="muted">
              CashFlow stops paying your landlord until you resume. Rent already paid for you is
              still collected on schedule.
            </Text>
          </View>
          <Toggle
            value={paused}
            onValueChange={(next) => void change({ status: next ? 'PAUSED' : 'ACTIVE' })}
            label="Pause rent splitting"
          />
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  shrink: { flexShrink: 1 },
});
