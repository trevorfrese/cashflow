import type { Installment, Lease } from '@cashflow/shared';
import { formatBps, formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Avatar,
  Button,
  Card,
  ChoiceChips,
  CoinMark,
  EmptyState,
  Notice,
  Pill,
  Text,
  statusPill,
} from '@/components';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { formatDate, formatPeriod, ordinal, todayIso } from '@/lib/forms';
import {
  useApplications,
  useInstallments,
  useLeases,
  useRentPlan,
  useRentPlans,
} from '@/lib/queries';
import { deriveStage, type Stage } from '@/lib/stage';
import { border, colors, fonts, hardShadow, spacing } from '@/theme';

export default function Home() {
  const { user } = useAuth();
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
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      >
        <View style={styles.topBar}>
          <View style={styles.brand}>
            <CoinMark size={34} />
            <Text variant="heading">CashFlow</Text>
          </View>
          <Avatar name={user?.fullName} />
        </View>

        {error ? <Notice tone="danger" message={describeError(error)} /> : null}

        {!biz.isLoading && biz.businesses.length === 0 ? (
          <Card>
            <Text variant="title">Welcome</Text>
            <Text variant="body" tone="muted">
              Set up your business to see whether CashFlow can pay your rent up front.
            </Text>
            <Button
              title="Set up your business"
              icon="arrow-right"
              onPress={() => router.push('/business/new')}
            />
          </Card>
        ) : null}

        {biz.businesses.length > 1 ? (
          <ChoiceChips
            options={biz.businesses.map((b) => ({ value: b.id, label: b.dba ?? b.legalName }))}
            value={business?.id ?? null}
            onChange={(id) => biz.select(id)}
            appearance="tabs"
          />
        ) : null}

        {business && stage ? (
          <StageCard stage={stage} leases={leases.data ?? []} />
        ) : loading ? (
          <Text tone="muted">Loading…</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function StageCard({ stage, leases }: { stage: Stage; leases: Lease[] }) {
  switch (stage.kind) {
    case 'NEEDS_APPLICATION':
      return (
        <Card>
          <Text variant="title">Apply in minutes</Text>
          <Text variant="body" tone="muted">
            Connect your bank account and get an instant decision based on your cash flow, not a
            credit score.
          </Text>
          <Button
            title="Start application"
            icon="arrow-right"
            onPress={() => router.push('/application/new')}
          />
        </Card>
      );
    case 'NEEDS_INFO':
      return (
        <Card>
          <Pill label="Needs info" tone="gold" />
          <Text variant="title">One more step</Text>
          <Text variant="body" tone="muted">
            {stage.application.decision?.reasons[0]?.message}
          </Text>
          <Button
            title="Continue"
            icon="arrow-right"
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
            variant="text"
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
          <Button
            title="Link your lease"
            icon="arrow-right"
            onPress={() => router.push('/lease/new')}
          />
          <Button
            title="View decision"
            variant="text"
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
            {ordinal(stage.lease.dueDayOfMonth)}.
          </Text>
          <Button
            title="Choose repayment schedule"
            icon="arrow-right"
            onPress={() =>
              router.push({ pathname: '/plan/new', params: { leaseId: stage.lease.id } })
            }
          />
        </Card>
      );
    case 'ACTIVE_PLAN':
      return (
        <PlanSummary
          planId={stage.plan.id}
          lease={leases.find((l) => l.id === stage.plan.leaseId)}
        />
      );
  }
}

function PlanSummary({ planId, lease }: { planId: string; lease: Lease | undefined }) {
  const plan = useRentPlan(planId);
  const installments = useInstallments(planId);
  const d = plan.data;
  if (!d) return <Text tone="muted">Loading plan…</Text>;

  const next = d.nextInstallment;
  const all = installments.data ?? [];
  const period =
    next?.periodMonth ??
    d.nextPayout?.periodMonth ??
    [...d.payouts].sort((a, b) => (a.periodMonth < b.periodMonth ? 1 : -1))[0]?.periodMonth;
  const periodItems = all
    .filter((i) => i.periodMonth === period)
    .sort((a, b) => a.sequence - b.sequence);
  const paidCount = periodItems.filter((i) => i.status === 'PAID').length;
  const periodPayout = d.payouts.find((p) => p.periodMonth === period) ?? d.nextPayout;
  const paidSoFar = all
    .filter((i) => i.status === 'PAID')
    .reduce((sum, i) => sum + i.totalCents, 0);
  const leftThisPeriod = periodItems
    .filter((i) => i.status !== 'PAID')
    .reduce((sum, i) => sum + i.totalCents, 0);

  return (
    <>
      <Card tone="gold" shadow="l">
        <View style={styles.heroBody}>
          <Text variant="label">
            {period ? formatPeriod(period) : 'Rent'}
            {lease ? ` · ${lease.propertyAddress.line1}` : ''}
          </Text>
          <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
            {formatCents(d.monthlyRentCents, { showCents: false })}
          </Text>
          <Text variant="body">{payoutLine(periodPayout, d.dueDayOfMonth)}</Text>
          {periodItems.length > 0 ? (
            <>
              <Blocks items={periodItems} />
              <Text style={styles.heroCount}>
                {paidCount} of {periodItems.length} paid back
              </Text>
            </>
          ) : null}
        </View>
      </Card>

      <Card>
        {next ? (
          <View style={styles.rowBetween}>
            <View style={{ gap: 2 }}>
              <Text variant="number" numberOfLines={1} adjustsFontSizeToFit>
                {formatCents(next.totalCents)}
              </Text>
              <Text variant="caption" tone="muted">
                Due {formatDate(next.dueDate)} · from your bank
              </Text>
            </View>
            <Pill {...nextPill(next)} />
          </View>
        ) : (
          <Text variant="body" tone="muted">
            Nothing due right now.
          </Text>
        )}
      </Card>

      <View style={styles.tiles}>
        <View style={[styles.tile, hardShadow('m')]}>
          <Text variant="label">Paid so far</Text>
          <Text variant="number" style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatCents(paidSoFar, { showCents: false })}
          </Text>
        </View>
        <View style={[styles.tile, hardShadow('m')]}>
          <Text variant="label">Left this month</Text>
          <Text variant="number" style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatCents(leftThisPeriod, { showCents: false })}
          </Text>
        </View>
      </View>

      {d.upcomingInstallments.length === 0 && !next ? (
        <EmptyState
          title="All caught up"
          message="Upcoming installments appear here 30 days before each rent due date."
        />
      ) : null}
    </>
  );
}

/** One block per installment in the period, filled gold once it is paid. */
function Blocks({ items }: { items: Installment[] }) {
  return (
    <View style={styles.blocks}>
      {items.map((i) => (
        <View
          key={i.id}
          style={[
            styles.block,
            { backgroundColor: i.status === 'PAID' ? colors.ink : colors.white },
          ]}
        />
      ))}
    </View>
  );
}

function payoutLine(
  payout: { status: string; scheduledFor: string; paidAt: string | null } | null | undefined,
  dueDay: number,
): string {
  if (!payout) return `Landlord paid in full on the ${ordinal(dueDay)}`;
  if (payout.status === 'PAID')
    return `Landlord paid in full on ${formatDate((payout.paidAt ?? payout.scheduledFor).slice(0, 10))}`;
  return `Landlord gets paid in full on ${formatDate(payout.scheduledFor)}`;
}

function nextPill(i: Installment): { label: string; tone: 'due' | 'late' | 'info' | 'paid' } {
  const today = todayIso();
  if (i.status === 'SCHEDULED') {
    if (i.dueDate < today) return { label: 'Overdue', tone: 'late' };
    const days = daysBetween(today, i.dueDate);
    if (days <= 7)
      return { label: days === 0 ? 'Due today' : `Due ${weekday(i.dueDate)}`, tone: 'due' };
    return { label: 'Scheduled', tone: 'info' };
  }
  const s = statusPill(i.status);
  return { label: s.label, tone: s.tone === 'late' ? 'late' : s.tone === 'paid' ? 'paid' : 'due' };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroBody: { gap: 6 },
  heroCount: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18, color: colors.ink },
  blocks: { flexDirection: 'row', gap: 6, marginTop: 6 },
  block: {
    flex: 1,
    height: 16,
    borderWidth: border.thin,
    borderColor: colors.ink,
    borderRadius: 4,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tiles: { flexDirection: 'row', gap: spacing.md },
  tile: {
    flex: 1,
    minWidth: 0,
    padding: 14,
    gap: 4,
    backgroundColor: colors.white,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: 12,
  },
  tileValue: { fontSize: 22, lineHeight: 26 },
});
