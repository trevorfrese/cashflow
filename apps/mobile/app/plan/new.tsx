import { buildInstallmentSchedule, formatBps, nextRentDueDate } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ListRow,
  Notice,
  Pill,
  Screen,
  Segmented,
  Text,
  TitleRow,
} from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatDate, formatMoney, ordinal, todayIso } from '@/lib/forms';
import { useApplications, useCreateRentPlan, useLeases } from '@/lib/queries';
import { border, colors, fonts, spacing } from '@/theme';

export default function NewPlan() {
  const { leaseId } = useLocalSearchParams<{ leaseId: string }>();
  const { business } = useBusiness();
  const leases = useLeases(business?.id);
  const applications = useApplications(business?.id);
  const create = useCreateRentPlan();
  const lease = leases.data?.find((l) => l.id === leaseId);
  const approved = applications.data?.find((a) => a.status === 'APPROVED');
  const recommended = approved?.decision?.recommendedInstallmentsPerMonth ?? 2;
  const [cadence, setCadence] = useState<number>(recommended);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (!lease || !approved?.decision?.feeBps) return null;
    const dueDate =
      lease.startsOn > todayIso()
        ? nextRentDueDate(lease.dueDayOfMonth, lease.startsOn)
        : nextRentDueDate(lease.dueDayOfMonth, todayIso());
    return buildInstallmentSchedule({
      rentCents: lease.monthlyRentCents,
      feeBps: approved.decision.feeBps,
      dueDate,
      installmentsPerMonth: cadence,
    });
  }, [lease, approved, cadence]);

  const start = async () => {
    if (!lease || !approved) return;
    setError(null);
    try {
      await create.mutateAsync({
        leaseId: lease.id,
        applicationId: approved.id,
        installmentsPerMonth: cadence,
      });
      router.replace('/(tabs)');
    } catch (e) {
      setError(describeError(e));
    }
  };

  const feeBps = approved?.decision?.feeBps ?? 0;

  return (
    <Screen
      back
      step="Step 4 of 4"
      title="Your rent plan"
      subtitle="CashFlow pays the landlord in full on the due date. Choose how you repay."
      footer={
        <Button
          title="Start plan"
          size="lg"
          icon="arrow-right"
          onPress={() => void start()}
          loading={create.isPending}
          disabled={!lease || !approved}
        />
      }
    >
      {error ? <Notice tone="danger" message={error} /> : null}
      {lease ? (
        <Card tone="gold">
          <Text variant="label">{lease.landlordName}</Text>
          <Text variant="money">{formatMoney(lease.monthlyRentCents)}</Text>
          <Text variant="body">paid in full on the {ordinal(lease.dueDayOfMonth)} each month</Text>
        </Card>
      ) : (
        <Text tone="muted">Loading lease…</Text>
      )}

      <View style={styles.group}>
        <Text style={styles.label}>Payments per month</Text>
        <Segmented
          options={[
            { value: 1, label: '1' },
            { value: 2, label: '2' },
            { value: 4, label: '4' },
          ]}
          value={cadence}
          onChange={setCadence}
        />
        <Text variant="caption" tone="muted">
          {cadence === recommended
            ? 'Recommended for your cash flow pattern.'
            : `We suggested ${recommended} a month, based on when your deposits come in and your cash buffer.`}
        </Text>
      </View>

      {preview ? (
        <Card shadowColor={colors.sky}>
          <TitleRow
            title="First month"
            variant="heading"
            pill={<Pill label={`${formatBps(feeBps)} fee`} tone="gold" />}
          />
          <Text variant="caption" tone="muted">
            Landlord paid {formatDate(preview.payoutDate)}. You repay:
          </Text>
          {preview.installments.map((i, idx) => (
            <ListRow
              key={i.sequence}
              title={formatDate(i.dueDate)}
              subtitle={`${formatMoney(i.principalCents)} rent + ${formatMoney(i.feeCents)} fee`}
              right={<Text variant="heading">{formatMoney(i.totalCents)}</Text>}
              last={idx === preview.installments.length - 1}
            />
          ))}
          <View style={styles.total}>
            <Text variant="bodyStrong">Total per month</Text>
            <Text variant="heading">{formatMoney(preview.payoutCents + preview.feeCents)}</Text>
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  label: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.ink },
  total: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.smd,
    marginTop: spacing.xs,
    borderTopWidth: border.width,
    borderTopColor: colors.ink,
    borderStyle: 'dashed',
  },
});
