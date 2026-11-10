import type { CashFlowSummary, DecisionReason } from '@cashflow/shared';
import { formatBps, formatCents } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Notice, Screen, ScoreGauge, Text } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatPeriod } from '@/lib/forms';
import { useApplication, useBankLinks, useResubmitApplication } from '@/lib/queries';
import { border, colors, radii, spacing } from '@/theme';

export default function Decision() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business } = useBusiness();
  const { data: app, isLoading } = useApplication(id, business?.id);
  const links = useBankLinks(business?.id);
  const resubmit = useResubmitApplication();
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !app) {
    return (
      <Screen back title="Decision">
        <Text tone="muted">{isLoading ? 'Loading…' : 'Application not found.'}</Text>
      </Screen>
    );
  }
  const d = app.decision;
  const linked = links.data?.filter((l) => l.status === 'LINKED') ?? [];

  const retry = async () => {
    setError(null);
    try {
      await resubmit.mutateAsync({
        applicationId: app.id,
        bankLinkId: linked[linked.length - 1]?.id,
      });
    } catch (e) {
      setError(describeError(e));
    }
  };

  const footer = (() => {
    if (app.status === 'APPROVED') {
      return (
        <Button
          title="Link your lease"
          size="lg"
          icon="arrow-right"
          onPress={() => router.push('/lease/new')}
        />
      );
    }
    if (app.status === 'NEEDS_INFO') {
      return linked.length > 0 ? (
        <Button
          title="Run the decision again"
          onPress={() => void retry()}
          loading={resubmit.isPending}
        />
      ) : (
        <Button
          title="Connect a bank account"
          variant="azure"
          onPress={() => router.push('/bank/connect')}
        />
      );
    }
    return (
      <Button title="Back to home" variant="secondary" onPress={() => router.replace('/(tabs)')} />
    );
  })();

  return (
    <Screen back title={headline(app.status)} footer={footer}>
      {error ? <Notice tone="danger" message={error} /> : null}
      {!d ? (
        <Text tone="muted">No decision yet.</Text>
      ) : (
        <>
          {d.score !== null && d.grade ? (
            <Card>
              <View style={styles.gaugeRow}>
                <ScoreGauge score={d.score} grade={d.grade} />
                <View style={{ flex: 1, gap: spacing.sm }}>
                  {app.status === 'APPROVED' ? (
                    <>
                      <Stat
                        label="Monthly rent limit"
                        value={formatCents(d.approvedMonthlyLimitCents ?? 0, { showCents: false })}
                      />
                      <Stat label="Fee per month" value={`${formatBps(d.feeBps ?? 0)} of rent`} />
                      <Stat
                        label="Suggested cadence"
                        value={`${d.recommendedInstallmentsPerMonth ?? 2} installments`}
                      />
                    </>
                  ) : (
                    <Text variant="body" tone="muted">
                      {summaryLine(app.status)}
                    </Text>
                  )}
                </View>
              </View>
            </Card>
          ) : (
            <Notice
              tone="info"
              title="More information needed"
              message={d.reasons[0]?.message ?? ''}
            />
          )}

          <Section
            title={
              app.status === 'DECLINED'
                ? 'Why we could not approve this'
                : 'What went into the decision'
            }
          >
            {orderReasons(d.reasons).map((r) => (
              <ReasonRow key={r.code} reason={r} />
            ))}
          </Section>

          {d.cashFlow ? <CashFlowCard summary={d.cashFlow} /> : null}
        </>
      )}
    </Screen>
  );
}

function headline(status: string): string {
  switch (status) {
    case 'APPROVED':
      return "You're approved";
    case 'DECLINED':
      return 'Not approved right now';
    case 'NEEDS_INFO':
      return 'A little more information';
    default:
      return 'Decision';
  }
}

function summaryLine(status: string): string {
  return status === 'DECLINED'
    ? 'The account did not meet our policy on one or more hard rules. The reasons below are specific so you know what would need to change.'
    : 'Underwriting ran but needs one more input before it can decide.';
}

function orderReasons(reasons: DecisionReason[]): DecisionReason[] {
  const rank: Record<DecisionReason['impact'], number> = { NEGATIVE: 0, INFO: 1, POSITIVE: 2 };
  return [...reasons].sort((a, b) => rank[a.impact] - rank[b.impact]);
}

function ReasonRow({ reason }: { reason: DecisionReason }) {
  const color =
    reason.impact === 'NEGATIVE'
      ? colors.jetRed
      : reason.impact === 'POSITIVE'
        ? colors.mint
        : colors.sky;
  return (
    <View style={styles.reason}>
      <View style={[styles.marker, { backgroundColor: color }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{labelFor(reason.code)}</Text>
        <Text variant="body" tone="muted">
          {reason.message}
        </Text>
      </View>
    </View>
  );
}

const LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  LIMIT_BELOW_REQUEST: 'Approved at a lower limit',
  RENT_TO_REVENUE: 'Rent affordability',
  CASH_FLOW_COVERAGE: 'Cash flow coverage',
  CASH_BUFFER: 'Cash buffer',
  ACCOUNT_CONDUCT: 'Account conduct',
  REVENUE_STABILITY: 'Revenue stability',
  REVENUE_TREND: 'Revenue trend',
  DEBT_LOAD: 'Existing debt',
  HISTORY_DEPTH: 'Bank history',
  BANK_LINK_REQUIRED: 'Bank account needed',
  INSUFFICIENT_HISTORY: 'Not enough history',
  REVENUE_MISMATCH: 'Revenue does not match',
  TIME_IN_BUSINESS: 'Time in business',
  REVENUE_TOO_LOW: 'Revenue below minimum',
  EXCESSIVE_OVERDRAFTS: 'Overdrafts',
  NEGATIVE_BALANCE_DAYS: 'Negative balance days',
  RENT_EXCEEDS_REVENUE_SHARE: 'Rent too large for revenue',
  REVENUE_DECLINING: 'Revenue declining',
  NEGATIVE_FREE_CASH_FLOW: 'No free cash flow',
  SCORE_BELOW_MINIMUM: 'Overall score',
  INSUFFICIENT_CAPACITY: 'Not enough capacity',
};
function labelFor(code: string): string {
  return LABELS[code] ?? code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <Text variant="heading">{title}</Text>
      <View style={{ gap: spacing.md, paddingTop: spacing.xs }}>{children}</View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="heading">{value}</Text>
    </View>
  );
}

function CashFlowCard({ summary: s }: { summary: CashFlowSummary }) {
  const max = Math.max(1, ...s.monthly.map((m) => m.revenueCents));
  return (
    <Card>
      <Text variant="heading">Your cash flow, from the bank</Text>
      <View style={styles.grid}>
        <Metric
          label="Verified revenue"
          value={`${formatCents(s.verifiedMonthlyRevenueCents, { showCents: false })}/mo`}
        />
        <Metric
          label="Free cash flow"
          value={`${formatCents(s.monthlyNetCashFlowCents, { showCents: false })}/mo`}
        />
        <Metric
          label="Cash on hand"
          value={s.daysOfCashOnHand === null ? 'Unknown' : `${s.daysOfCashOnHand} days`}
        />
        <Metric label="Overdrafts (90d)" value={String(s.nsfCount90)} />
      </View>
      {s.monthly.length > 0 ? (
        <View style={{ gap: 6, paddingTop: spacing.sm }}>
          <Text variant="label">Monthly revenue</Text>
          <View style={styles.bars}>
            {s.monthly.map((m) => (
              <View key={m.month} style={styles.barCol}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: Math.max(8, Math.round((m.revenueCents / max) * 72)),
                      backgroundColor: m.nsfCount > 0 ? colors.jetRed : colors.gold,
                    },
                  ]}
                />
              </View>
            ))}
          </View>
          <View style={styles.barLabels}>
            <Text variant="caption" tone="muted">
              {formatPeriod(s.monthly[0]!.month)}
            </Text>
            <Text variant="caption" tone="muted">
              {formatPeriod(s.monthly[s.monthly.length - 1]!.month)}
            </Text>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gaugeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  reason: { flexDirection: 'row', gap: spacing.smd, alignItems: 'flex-start' },
  marker: {
    width: 14,
    height: 14,
    borderRadius: 3,
    marginTop: 4,
    borderWidth: border.thin,
    borderColor: colors.ink,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.sm },
  metric: {
    width: '47%',
    backgroundColor: colors.paper,
    borderWidth: border.thin,
    borderColor: colors.ink,
    borderRadius: radii.chip,
    padding: 10,
    gap: 2,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 76 },
  barCol: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderRadius: 3, borderWidth: border.thin, borderColor: colors.ink },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between' },
});
