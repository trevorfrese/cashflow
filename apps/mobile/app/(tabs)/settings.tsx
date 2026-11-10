import type { Lease, RentPlan } from '@cashflow/shared';
import { formatBps, formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  ListRow,
  Notice,
  Pill,
  Screen,
  Segmented,
  Text,
  Toggle,
} from '@/components';
import { API_URL, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { ordinal } from '@/lib/forms';
import { useBankLinks, useLeases, useRentPlans, useUpdateRentPlan } from '@/lib/queries';
import { spacing } from '@/theme';

const CADENCES = [
  { value: 1, label: '1 a month' },
  { value: 2, label: '2 a month' },
  { value: 4, label: '4 a month' },
] as const;

export default function Settings() {
  const { user, signOut } = useAuth();
  const { business, businesses } = useBusiness();
  const links = useBankLinks(business?.id);
  const leases = useLeases(business?.id);
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status !== 'CLOSED') ?? null;
  const lease = leases.data?.find((l) => l.id === plan?.leaseId) ?? null;

  return (
    <Screen title="Settings">
      <Card style={styles.profile}>
        <Avatar name={user?.fullName} size={52} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading">{user?.fullName}</Text>
          <Text variant="body" tone="muted">
            {user?.email}
          </Text>
        </View>
      </Card>

      <Card>
        <Text variant="heading">Rent</Text>
        {business ? (
          <Text variant="caption" tone="muted">
            {business.dba ?? business.legalName}
          </Text>
        ) : null}
        {plan && lease ? (
          <RentSettings plan={plan} lease={lease} />
        ) : (
          <Text tone="muted">No rent plan for this business yet.</Text>
        )}
      </Card>

      <Card>
        <Text variant="heading">Businesses</Text>
        {businesses.map((b, idx) => (
          <ListRow
            key={b.id}
            title={b.dba ?? b.legalName}
            subtitle={`${formatCents(b.statedMonthlyRevenueCents, { showCents: false })} a month`}
            right={
              <Pill
                label={b.status.charAt(0) + b.status.slice(1).toLowerCase()}
                tone={b.status === 'ACTIVE' ? 'paid' : 'neutral'}
              />
            }
            last={idx === businesses.length - 1}
          />
        ))}
        <Button
          title="Add a business"
          variant="secondary"
          size="sm"
          onPress={() => router.push('/business/new')}
        />
      </Card>

      <Card>
        <Text variant="heading">Bank accounts</Text>
        {(links.data ?? []).length === 0 ? (
          <Text tone="muted">None connected yet.</Text>
        ) : (
          links.data!.map((l, idx) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Ending ${l.accountMask}`}
              right={
                <Pill
                  label={l.status === 'LINKED' ? 'Linked' : l.status}
                  tone={l.status === 'LINKED' ? 'paid' : 'late'}
                />
              }
              last={idx === links.data!.length - 1}
            />
          ))
        )}
        <Button
          title="Connect an account"
          variant="azure"
          size="sm"
          onPress={() => router.push('/bank/connect')}
        />
      </Card>

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
        API {API_URL}
      </Text>
    </Screen>
  );
}

/** The BNPL controls for a running plan: how often to repay, and pause or resume. */
function RentSettings({ plan, lease }: { plan: RentPlan; lease: Lease }) {
  const update = useUpdateRentPlan();
  const [error, setError] = useState<string | null>(null);
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
    <>
      <ListRow
        title={formatCents(plan.monthlyRentCents, { showCents: false })}
        subtitle={`To ${lease.landlordName} on the ${ordinal(plan.dueDayOfMonth)} · ${formatBps(plan.feeBps)} fee`}
        right={<Pill label={paused ? 'Paused' : 'Active'} tone={paused ? 'due' : 'paid'} />}
      />
      <View style={styles.setting}>
        <Text variant="bodyStrong">Repay in</Text>
        <Segmented
          options={CADENCES}
          value={plan.installmentsPerMonth}
          onChange={(v) => void change({ installmentsPerMonth: v })}
        />
        <Text variant="caption" tone="muted">
          Applies from the next rent period.
        </Text>
      </View>
      <View style={styles.toggleRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="bodyStrong">Pause rent splitting</Text>
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
      {error ? <Notice tone="danger" message={error} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  setting: { gap: spacing.sm, paddingTop: spacing.sm },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.smd,
  },
  profile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
