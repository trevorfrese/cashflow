import { formatBps, formatCents } from '@cashflow/shared';
import { Link, router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Card,
  CoinMark,
  DemoBanner,
  EmptyState,
  Notice,
  Pill,
  Text,
  statusPill,
} from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatDate } from '@/lib/forms';
import { useApplications, useLeases, useRentPlan, useRentPlans } from '@/lib/queries';
import { deriveStage, type Stage } from '@/lib/stage';
import { colors, radii, spacing } from '@/theme';

export default function Home() {
  const biz = useBusiness();
  const business = biz.business;
  const applications = useApplications(business?.id);
  const leases = useLeases(business?.id);
  const plans = useRentPlans(business?.id);
  const loading = biz.isLoading || applications.isLoading || leases.isLoading || plans.isLoading;
  const error = biz.error ?? applications.error ?? leases.error ?? plans.error;
  const stage =
    applications.data && leases.data && plans.data
      ? deriveStage({ applications: applications.data, leases: leases.data, plans: plans.data })
      : null;
  const refresh = () => {
    biz.refetch();
    void applications.refetch();
    void leases.refetch();
    void plans.refetch();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <DemoBanner />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      >
        <View style={styles.brand}>
          <CoinMark size={28} />
          <Text variant="heading" style={styles.wordmark}>
            CashFlow
          </Text>
        </View>

        {error ? <Notice tone="danger" message={describeError(error)} /> : null}

        {!biz.isLoading && biz.businesses.length === 0 ? (
          <Card>
            <Text variant="title">Welcome</Text>
            <Text variant="body" tone="muted">
              Set up your business to see whether CashFlow can pay your rent up front.
            </Text>
            <Button title="Set up your business" onPress={() => router.push('/business/new')} />
          </Card>
        ) : null}

        {biz.businesses.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.switcher}
          >
            {biz.businesses.map((b) => {
              const selected = b.id === business?.id;
              return (
                <Pressable
                  key={b.id}
                  onPress={() => biz.select(b.id)}
                  style={[styles.bizChip, selected && styles.bizChipSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text
                    variant="caption"
                    style={{ color: selected ? colors.onPrimary : colors.text }}
                  >
                    {b.dba ?? b.legalName}
                  </Text>
                </Pressable>
              );
            })}
            <Link href="/business/new" asChild>
              <Pressable style={styles.bizChip} accessibilityRole="button">
                <Text variant="caption" tone="primary">
                  + Add
                </Text>
              </Pressable>
            </Link>
          </ScrollView>
        ) : null}

        {business && stage ? (
          <StageCard stage={stage} />
        ) : loading ? (
          <Text tone="muted">Loading…</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function StageCard({ stage }: { stage: Stage }) {
  switch (stage.kind) {
    case 'NEEDS_APPLICATION':
      return (
        <Card>
          <Text variant="title">Apply in minutes</Text>
          <Text variant="body" tone="muted">
            Connect your bank account and get an instant decision based on your cash flow, not a
            credit score.
          </Text>
          <Button title="Start application" onPress={() => router.push('/application/new')} />
        </Card>
      );
    case 'NEEDS_INFO':
      return (
        <Card>
          <Pill label="Needs info" tone="info" />
          <Text variant="title">One more step</Text>
          <Text variant="body" tone="muted">
            {stage.application.decision?.reasons[0]?.message}
          </Text>
          <Button
            title="Continue"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
        </Card>
      );
    case 'DECLINED':
      return (
        <Card>
          <Pill label="Not approved" tone="late" />
          <Text variant="title">We could not approve this yet</Text>
          <Text variant="body" tone="muted">
            The decision lists exactly what would need to change.
          </Text>
          <Button
            title="See the reasons"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
          <Button
            title="Start a new application"
            variant="ghost"
            onPress={() => router.push('/application/new')}
          />
        </Card>
      );
    case 'APPROVED_NO_LEASE':
      return (
        <Card>
          <Pill label="Approved" tone="paid" />
          <Text variant="title">
            Approved for up to{' '}
            {formatCents(stage.application.decision?.approvedMonthlyLimitCents ?? 0, {
              showCents: false,
            })}{' '}
            a month
          </Text>
          <Text variant="body" tone="muted">
            {formatBps(stage.application.decision?.feeBps ?? 0)} fee per month. Link your lease to
            start.
          </Text>
          <Button title="Link your lease" onPress={() => router.push('/lease/new')} />
          <Button
            title="View decision"
            variant="ghost"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
        </Card>
      );
    case 'LEASE_NO_PLAN':
      return (
        <Card>
          <Pill label="Lease linked" tone="paid" />
          <Text variant="title">Start your rent plan</Text>
          <Text variant="body" tone="muted">
            {stage.lease.landlordName},{' '}
            {formatCents(stage.lease.monthlyRentCents, { showCents: false })} due on the{' '}
            {stage.lease.dueDayOfMonth}
            {suffix(stage.lease.dueDayOfMonth)}.
          </Text>
          <Button
            title="Choose repayment schedule"
            onPress={() =>
              router.push({ pathname: '/plan/new', params: { leaseId: stage.lease.id } })
            }
          />
        </Card>
      );
    case 'ACTIVE_PLAN':
      return <PlanSummary planId={stage.plan.id} />;
  }
}

function PlanSummary({ planId }: { planId: string }) {
  const plan = useRentPlan(planId);
  const d = plan.data;
  if (!d) return <Text tone="muted">Loading plan…</Text>;
  const next = d.nextInstallment;
  const payout = d.nextPayout;
  return (
    <>
      <Card tone="ink">
        <Text variant="caption" style={{ color: colors.brightGold }}>
          Next payment
        </Text>
        {next ? (
          <>
            <Text variant="money" style={{ color: colors.paper }}>
              {formatCents(next.totalCents)}
            </Text>
            <View style={styles.rowBetween}>
              <Text variant="body" style={{ color: colors.stone }}>
                Due {formatDate(next.dueDate)}
              </Text>
              <Pill {...statusPill(next.status)} />
            </View>
          </>
        ) : (
          <Text variant="body" style={{ color: colors.stone }}>
            Nothing due right now.
          </Text>
        )}
        <Button
          title="View schedule"
          variant="secondary"
          onPress={() => router.push('/(tabs)/schedule')}
          style={{ marginTop: spacing.sm }}
        />
      </Card>
      <Card>
        <Text variant="heading">Landlord payout</Text>
        {payout ? (
          <View style={styles.rowBetween}>
            <View>
              <Text variant="bodyStrong">
                {formatCents(payout.amountCents, { showCents: false })}
              </Text>
              <Text variant="caption" tone="muted">
                {payout.status === 'PAID' && payout.paidAt
                  ? `Paid ${formatDate(payout.paidAt.slice(0, 10))}`
                  : `Scheduled ${formatDate(payout.scheduledFor)}`}
              </Text>
            </View>
            <Pill {...statusPill(payout.status)} />
          </View>
        ) : (
          <Text tone="muted">No payout scheduled.</Text>
        )}
      </Card>
      <Card>
        <Text variant="heading">Plan terms</Text>
        <View style={styles.terms}>
          <Term
            label="Monthly rent"
            value={formatCents(d.monthlyRentCents, { showCents: false })}
          />
          <Term label="Fee" value={formatBps(d.feeBps)} />
          <Term label="Installments" value={`${d.installmentsPerMonth} / month`} />
          <Term label="Status" value={d.status.charAt(0) + d.status.slice(1).toLowerCase()} />
        </View>
      </Card>
      {d.upcomingInstallments.length === 0 && !next ? (
        <EmptyState
          title="All caught up"
          message="Upcoming installments appear here 30 days before each rent due date."
        />
      ) : null}
    </>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '47%' }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

function suffix(d: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = d % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wordmark: { fontWeight: '800', letterSpacing: -0.3 },
  switcher: { gap: spacing.sm },
  bizChip: {
    paddingHorizontal: 14,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  bizChipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  terms: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
