import { formatBps, formatCents } from '@cashflow/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, EmptyState, Notice, Pill, Screen, Segmented, Text, Toggle } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { ordinal } from '@/lib/forms';
import { useLeases, useRentPlans, useUpdateRentPlan } from '@/lib/queries';
import { spacing } from '@/theme';

const CADENCES = [
  { value: 1, label: '1 a month' },
  { value: 2, label: '2 a month' },
  { value: 4, label: '4 a month' },
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

  if (!plans.isLoading && (!plan || !lease)) {
    return (
      <Screen back title="Rent">
        <EmptyState
          title="No rent plan yet"
          message={`${business?.dba ?? business?.legalName ?? 'This business'} is not splitting rent yet. Start from the home screen.`}
        />
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

  return (
    <Screen back title="Rent" subtitle={business?.dba ?? business?.legalName}>
      {error ? <Notice tone="danger" message={error} /> : null}
      <Card tone="gold">
        <View style={styles.rowBetween}>
          <Text variant="label">Monthly rent</Text>
          <Pill label={paused ? 'Paused' : 'Active'} tone={paused ? 'due' : 'paid'} />
        </View>
        <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
          {formatCents(plan.monthlyRentCents, { showCents: false })}
        </Text>
        <Text variant="body">
          To {lease.landlordName} on the {ordinal(plan.dueDayOfMonth)} · {formatBps(plan.feeBps)}{' '}
          fee
        </Text>
      </Card>

      <Card>
        <Text variant="heading">Repay in</Text>
        <Segmented
          options={CADENCES}
          value={plan.installmentsPerMonth}
          onChange={(v) => void change({ installmentsPerMonth: v })}
        />
        <Text variant="caption" tone="muted">
          Applies from the next rent period. Two a month is the 1st and the 15th.
        </Text>
      </Card>

      <Card>
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="heading">Pause rent splitting</Text>
            <Text variant="caption" tone="muted">
              CashFlow stops paying the landlord and collecting until you resume.
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
});
