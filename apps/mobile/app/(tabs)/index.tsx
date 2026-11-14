import type {
  GraduationOffer,
  Installment,
  Lease,
  PassThroughPeriod,
  UnderwritingApplication,
} from '@cashflow/shared';
import { formatBps } from '@cashflow/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
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
import { DevTapTarget } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatDate, formatMoney, formatPeriod, ordinal, plural, todayIso } from '@/lib/forms';
import {
  currentGraduationOffer,
  isMissedPeriod,
  latestFinishedPeriod,
  onTimeLine,
  periodStatusLabel,
} from '@/lib/pass-through';
import {
  useAcceptGraduationOffer,
  useApplications,
  useConnections,
  useInstallments,
  useLeases,
  useNotices,
  usePassThroughOffer,
  usePayInstallment,
  usePaymentHistory,
  useRentPlan,
  useRentPlans,
} from '@/lib/queries';
import { pendingActions } from '@/lib/connections';
import { longDate } from '@/lib/decision';
import { heldPayoutNotice, IN_REVIEW_COPY, pastDueNotice } from '@/lib/plan-notices';
import { deriveStage, type Stage } from '@/lib/stage';
import { border, colors, spacing } from '@/theme';

/** Anything about the business's connected data that needs the owner, with the way to fix it. */
function ConnectionPrompts({ businessId }: { businessId: string | undefined }) {
  const list = useConnections(businessId);
  const actions = pendingActions(list.data).filter((a) => a.code !== 'CONNECT_BANK');
  if (actions.length === 0) return null;
  return (
    <Card>
      {actions.map((a) => (
        <Notice key={a.code} tone="warning" title="Action needed" message={a.message} />
      ))}
      <Button title="Review connections" size="sm" onPress={() => router.push('/connections')} />
    </Card>
  );
}

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
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      >
        <View style={styles.topBar}>
          <View style={styles.brand}>
            <DevTapTarget>
              <CoinMark size={40} />
            </DevTapTarget>
            <Text variant="display">CashFlow</Text>
          </View>
        </View>

        {error ? <Notice tone="danger" message={describeError(error)} /> : null}
        <ConnectionPrompts businessId={business?.id} />

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
            title="See what we need"
            icon="arrow-right"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
        </Card>
      );
    case 'IN_REVIEW':
      return (
        <Card>
          <Pill label="In review" tone="due" />
          <Text variant="title">{IN_REVIEW_COPY.title}</Text>
          <Text variant="body" tone="muted">
            {IN_REVIEW_COPY.message}
          </Text>
          <Button
            title="View application"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
        </Card>
      );
    case 'DECLINED':
      return <DeclinedCard applicationId={stage.application.id} />;
    case 'APPROVED_NO_LEASE':
      return (
        <Card>
          <Pill label="Approved" tone="paid" />
          <Text variant="title">
            Approved for up to{' '}
            {formatMoney(stage.application.decision?.approvedMonthlyLimitCents ?? 0)} a month
          </Text>
          <Text variant="body" tone="muted">
            {approvedLine(stage.application)}
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
            {stage.lease.landlordName}, {formatMoney(stage.lease.monthlyRentCents)} due on the{' '}
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
    case 'RENT_OVER_LIMIT':
      return (
        <Card>
          <Pill label="Approved for less" tone="due" />
          <Text variant="title">Your rent is above your limit</Text>
          <Text variant="body" tone="muted">
            {`We can pay up to ${formatMoney(stage.application.decision?.approvedMonthlyLimitCents ?? 0)} a month, and the rent on your lease with ${stage.lease.landlordName} is ${formatMoney(stage.lease.monthlyRentCents)}. We pay a whole month's rent or none of it, so a plan cannot start on this lease.`}
          </Text>
          <Button
            title="See your options"
            icon="arrow-right"
            onPress={() =>
              router.push({ pathname: '/application/[id]', params: { id: stage.application.id } })
            }
          />
        </Card>
      );
    case 'ACTIVE_PLAN':
      if (stage.plan.kind === 'PASS_THROUGH') {
        return (
          <PassThroughSummary
            planId={stage.plan.id}
            businessId={stage.plan.businessId}
            lease={leases.find((l) => l.id === stage.plan.leaseId)}
          />
        );
      }
      return (
        <PlanSummary
          planId={stage.plan.id}
          lease={leases.find((l) => l.id === stage.plan.leaseId)}
        />
      );
  }
}

/** The fee, and when the limit is below the rent asked for, that the lease must fit it. */
function approvedLine(a: UnderwritingApplication): string {
  const fee = `${formatBps(a.decision?.feeBps ?? 0)} fee per month.`;
  const limit = a.decision?.approvedMonthlyLimitCents ?? 0;
  if (a.requestedMonthlyRentCents > limit)
    return `${fee} That is less than the ${formatMoney(a.requestedMonthlyRentCents)} rent you asked for, so link a lease with rent at or below it.`;
  return `${fee} Link your lease to start.`;
}

/** A declined application, with the free pass-through plan when it is offered. */
function DeclinedCard({ applicationId }: { applicationId: string }) {
  const offer = usePassThroughOffer(applicationId);
  const free = offer.data?.eligible ? offer.data : null;
  const open = () => router.push({ pathname: '/application/[id]', params: { id: applicationId } });
  return (
    <Card>
      <Pill label="Not approved" tone="late" />
      <Text variant="title">We could not approve this yet</Text>
      <Text variant="body" tone="muted">
        The decision lists exactly what would need to change.
      </Text>
      {free ? (
        <>
          <Text variant="bodyStrong">{free.headline}</Text>
          <Text variant="body" tone="muted">
            We collect your rent a few days early and pay your landlord on time. No fee.
          </Text>
          <Button title="See the free plan" variant="azure" icon="arrow-right" onPress={open} />
        </>
      ) : (
        <Button title="See the reasons" variant="secondary" onPress={open} />
      )}
      <Button
        title="Start a new application"
        variant="text"
        onPress={() => router.push('/application/new')}
      />
    </Card>
  );
}

/**
 * The free pass-through plan: the month in progress (when we collect, when the landlord is
 * paid), how last month went, and an offer to move to a split rent plan when there is one.
 */
function PassThroughSummary({
  planId,
  businessId,
  lease,
}: {
  planId: string;
  businessId: string;
  lease: Lease | undefined;
}) {
  const plan = useRentPlan(planId);
  const history = usePaymentHistory(businessId);
  const d = plan.data;
  if (!d) return <Text tone="muted">Loading plan…</Text>;

  const periods = d.passThrough?.periods ?? [];
  const next = d.passThrough?.nextPeriod ?? null;
  const finished = latestFinishedPeriod(periods);
  const missed = finished && isMissedPeriod(finished) ? finished : null;
  const offer = currentGraduationOffer(d.graduationOffer, history.data?.graduationOffer);
  const landlord = lease?.landlordName ?? 'your landlord';

  return (
    <>
      {missed ? (
        <Notice
          tone="danger"
          title={`${formatPeriod(missed.periodMonth)} rent was not paid`}
          message={missed.message}
        />
      ) : null}
      {offer ? (
        <GraduationCard
          offer={offer}
          onDone={() => {
            void plan.refetch();
            void history.refetch();
          }}
        />
      ) : null}

      <Card tone="gold" shadow="l">
        <Text variant="label">
          {next ? `${formatPeriod(next.periodMonth)} rent` : 'Free pass-through plan'}
        </Text>
        <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
          {formatMoney(next?.amountCents ?? d.monthlyRentCents)}
        </Text>
        {next ? (
          <>
            <PeriodStatus period={next} />
            <Text variant="body">{next.message}</Text>
          </>
        ) : (
          <Text variant="body">{`Paid to ${landlord} on the ${ordinal(d.dueDayOfMonth)} each month. Your next month shows here before it is collected.`}</Text>
        )}
      </Card>

      {finished && !missed ? (
        <Card>
          <Text variant="heading">{formatPeriod(finished.periodMonth)}</Text>
          <PeriodStatus period={finished} />
          <Text variant="body" tone="muted">
            {finished.message}
          </Text>
        </Card>
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <Text variant="caption" tone="muted">
          Free plan. No fee and no late fees.
        </Text>
        {history.data ? (
          <Text variant="caption" tone="muted">
            {/* With an offer on screen, the countdown to a review would contradict it. */}
            {onTimeLine(offer ? { ...history.data, monthsUntilReview: null } : history.data)}
          </Text>
        ) : null}
      </View>
    </>
  );
}

/** A month's status as a tag on its own line, never beside long text. */
function PeriodStatus({ period }: { period: PassThroughPeriod }) {
  const s = periodStatusLabel(period.status);
  return (
    <View style={styles.pillLine}>
      <Pill label={s.label} tone={s.tone} />
    </View>
  );
}

/** An offer to move from the free plan to a split rent plan. The owner has to accept it. */
function GraduationCard({ offer, onDone }: { offer: GraduationOffer; onDone: () => void }) {
  const accept = useAcceptGraduationOffer();
  const [error, setError] = useState<string | null>(null);
  const open = offer.status === 'OFFERED';

  const onAccept = async () => {
    setError(null);
    try {
      await accept.mutateAsync(offer.id);
      onDone();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <Card shadowColor={colors.azure}>
      <View style={styles.pillLine}>
        <Pill
          label={open ? 'New offer' : offer.status === 'ACCEPTED' ? 'Accepted' : 'Done'}
          tone={open ? 'info' : 'paid'}
        />
      </View>
      <Text variant="heading">Split your rent</Text>
      <Text variant="body">{offer.message}</Text>
      {open ? (
        <>
          <Text variant="body" tone="muted">
            {`The fee is ${formatBps(offer.feeBps)} of rent, and you repay in ${plural(offer.installmentsPerMonth, 'payment')} a month.`}
          </Text>
          <Text variant="caption" tone="muted">
            {`Offer open until ${formatDate(offer.expiresOn)}.`}
          </Text>
          {error ? <Notice tone="danger" message={error} /> : null}
          <Button
            title="Accept the offer"
            variant="azure"
            onPress={() => void onAccept()}
            loading={accept.isPending}
          />
        </>
      ) : null}
    </Card>
  );
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
  const periodPayout = d.payouts.find((p) => p.periodMonth === period) ?? d.nextPayout;
  const feeCents = periodItems.reduce((sum, i) => sum + i.feeCents, 0);
  const pastDue = pastDueNotice(d);
  const held = heldPayoutNotice(d.heldPayout);

  return (
    <>
      {pastDue ? (
        <Notice tone={pastDue.tone} title={pastDue.title} message={pastDue.message} />
      ) : null}
      {held ? <Notice tone={held.tone} title={held.title} message={held.message} /> : null}
      {d.advanceFrozen ? <FreezeNoticeCard applicationId={d.applicationId} /> : null}
      <Card tone="gold" shadow="l">
        <Text variant="label">{period ? `${formatPeriod(period)} rent` : 'Rent'}</Text>
        <Text variant="money" numberOfLines={1} adjustsFontSizeToFit>
          {formatMoney(d.monthlyRentCents)}
        </Text>
        <Text variant="body">{payoutLine(periodPayout, lease, d.dueDayOfMonth)}</Text>
      </Card>

      {periodItems.length > 0 ? (
        <Card>
          <Text variant="heading">You pay back</Text>
          {periodItems.map((i, idx) => (
            <InstallmentRow
              key={i.id}
              installment={i}
              count={periodItems.length}
              planId={planId}
              payable={periodPayout?.status === 'PAID'}
              held={periodPayout?.status === 'HELD'}
              last={idx === periodItems.length - 1}
            />
          ))}
          {feeCents > 0 ? (
            <Text variant="caption" tone="muted">
              Includes the {formatMoney(feeCents)} CashFlow fee ({formatBps(d.feeBps)}), split
              across the payments.
            </Text>
          ) : null}
        </Card>
      ) : (
        <EmptyState
          title="All caught up"
          message="Your next payments appear here 30 days before rent is due."
        />
      )}
    </>
  );
}

/**
 * A plan a periodic review put on hold: the notice we sent about it, with the reasons, like
 * the notices on a decision. Shown while the hold lasts.
 */
function FreezeNoticeCard({ applicationId }: { applicationId: string }) {
  const notices = useNotices(applicationId);
  const notice = [...(notices.data ?? [])]
    .filter((n) => n.kind === 'PLAN_FROZEN')
    .sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1))[0];
  if (!notice) return null;
  return (
    <Card>
      <Pill label="Notice of action" tone="late" />
      <Text variant="bodyStrong">{notice.title}</Text>
      <Text variant="body" tone="muted">
        {`We will not pay your landlord for new rent periods until our team has reviewed your plan. Sent ${longDate(notice.deliveredAt)} in the app.`}
      </Text>
      <Button
        title="Read the notice"
        variant="secondary"
        size="sm"
        icon="arrow-right"
        onPress={() =>
          router.push({ pathname: '/notice/[id]', params: { id: notice.id, applicationId } })
        }
      />
    </Card>
  );
}

/** One installment in the period, with Pay now once CashFlow has paid the landlord. */
function InstallmentRow({
  installment: i,
  count,
  planId,
  payable,
  held,
  last,
}: {
  installment: Installment;
  count: number;
  planId: string;
  payable: boolean;
  /** The landlord payout for this month is on hold, so nothing is collected yet. */
  held: boolean;
  last: boolean;
}) {
  const pay = usePayInstallment(planId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPay =
    payable &&
    (i.status === 'SCHEDULED' ||
      i.status === 'FAILED' ||
      i.status === 'LATE' ||
      i.status === 'CHARGED_OFF');
  const paid = i.status === 'PAID';
  const behind = i.status === 'FAILED' || i.status === 'LATE' || i.status === 'CHARGED_OFF';

  const onPay = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    try {
      await pay.mutateAsync({ installmentId: i.id });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <View style={[styles.installment, !last && styles.divider]}>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="bodyStrong">{installmentLabel(i.sequence, count)}</Text>
          <Text variant="caption" tone="muted">
            {paid && i.paidAt ? `Paid ${formatDate(i.paidAt.slice(0, 10))}` : formatDate(i.dueDate)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text variant="heading">{formatMoney(i.totalCents)}</Text>
          <Pill {...(paid ? { label: 'Paid', tone: 'paid' } : nextPill(i, held))} />
        </View>
      </View>
      {error ? <Notice tone="danger" message={error} /> : null}
      {canPay ? (
        <View style={{ gap: spacing.sm }}>
          <Button
            title={confirming ? `Confirm ${formatMoney(i.totalCents)} from your bank` : 'Pay now'}
            variant={confirming || behind ? 'primary' : 'secondary'}
            size="sm"
            onPress={() => void onPay()}
            loading={pay.isPending}
          />
          {confirming ? (
            <Button title="Cancel" variant="text" size="sm" onPress={() => setConfirming(false)} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** "1st half" and "2nd half" for two installments, "Payment 1 of 4" otherwise. */
function installmentLabel(sequence: number, count: number): string {
  if (count === 1) return 'Full amount';
  if (count === 2) return sequence === 1 ? '1st half' : '2nd half';
  return `Payment ${sequence} of ${count}`;
}

function payoutLine(
  payout: { status: string; scheduledFor: string; paidAt: string | null } | null | undefined,
  lease: Lease | undefined,
  dueDay: number,
): string {
  const landlord = lease?.landlordName ?? 'your landlord';
  if (!payout) return `Paid in full to ${landlord} on the ${ordinal(dueDay)}`;
  if (payout.status === 'PAID')
    return `Paid in full to ${landlord} on ${formatDate((payout.paidAt ?? payout.scheduledFor).slice(0, 10))}`;
  if (payout.status === 'HELD')
    return `On hold. It was due to ${landlord} on ${formatDate(payout.scheduledFor)}`;
  if (payout.status === 'CANCELLED')
    return `Not sent to ${landlord} for this month. Pay your landlord directly`;
  return `Goes to ${landlord} in full on ${formatDate(payout.scheduledFor)}`;
}

function nextPill(
  i: Installment,
  held: boolean,
): { label: string; tone: 'due' | 'late' | 'info' | 'paid' } {
  const today = todayIso();
  if (i.status === 'SCHEDULED' && held) return { label: 'Waiting', tone: 'due' };
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
  topBar: { marginBottom: spacing.xs },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  installment: { paddingVertical: spacing.smd, gap: spacing.sm },
  pillLine: { flexDirection: 'row' },
  divider: { borderBottomWidth: border.thin, borderBottomColor: colors.ink },
});
