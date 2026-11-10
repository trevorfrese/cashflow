import type { Installment } from '@cashflow/shared';
import { formatCents } from '@cashflow/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  ListRow,
  Notice,
  Pill,
  Screen,
  Text,
  statusPill,
} from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { formatDate, formatPeriod, todayIso } from '@/lib/forms';
import { useInstallments, usePayInstallment, usePayouts, useRentPlans } from '@/lib/queries';
import { border, colors, spacing } from '@/theme';

export default function Schedule() {
  const { business } = useBusiness();
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status === 'ACTIVE') ?? plans.data?.[0];
  const installments = useInstallments(plan?.id);
  const payouts = usePayouts(plan?.id);

  if (!plans.isLoading && !plan) {
    return (
      <Screen title="Schedule">
        <EmptyState
          title="No rent plan yet"
          message="Your installment schedule shows up here once a plan is active."
        />
      </Screen>
    );
  }

  const byPeriod = new Map<string, Installment[]>();
  for (const i of installments.data ?? []) {
    byPeriod.set(i.periodMonth, [...(byPeriod.get(i.periodMonth) ?? []), i]);
  }
  const periods = [...byPeriod.keys()].sort().reverse();
  const today = todayIso();

  return (
    <Screen title="Schedule">
      {periods.length === 0 && !installments.isLoading ? (
        <EmptyState
          title="Nothing scheduled"
          message="Installments are generated 30 days before each due date."
        />
      ) : null}
      {periods.map((period) => {
        const items = byPeriod.get(period)!.sort((a, b) => a.sequence - b.sequence);
        const payout = payouts.data?.find((p) => p.periodMonth === period);
        return (
          <Card key={period}>
            <View style={styles.header}>
              <Text variant="heading">{formatPeriod(period)}</Text>
              {payout ? (
                <Pill
                  {...statusPill(payout.status)}
                  label={
                    payout.status === 'PAID'
                      ? 'Landlord paid'
                      : `Payout ${statusPill(payout.status).label.toLowerCase()}`
                  }
                />
              ) : null}
            </View>
            {items.map((i, idx) => (
              <InstallmentRow
                key={i.id}
                installment={i}
                count={items.length}
                today={today}
                planId={plan!.id}
                payoutPaid={payout?.status === 'PAID'}
                last={idx === items.length - 1}
              />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}

function InstallmentRow({
  installment: i,
  count,
  today,
  planId,
  payoutPaid,
  last,
}: {
  installment: Installment;
  count: number;
  today: string;
  planId: string;
  /** Early payment is only possible once CashFlow has paid the landlord for the period. */
  payoutPaid: boolean;
  last: boolean;
}) {
  const pay = usePayInstallment(planId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payable =
    payoutPaid && (i.status === 'SCHEDULED' || i.status === 'FAILED' || i.status === 'LATE');
  const overdue = i.status !== 'PAID' && i.dueDate < today;
  const pill =
    i.status === 'SCHEDULED' && overdue
      ? { label: 'Overdue', tone: 'late' as const }
      : statusPill(i.status);

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
    <View>
      <ListRow
        title={`Installment ${i.sequence} of ${count}`}
        subtitle={
          i.status === 'PAID' && i.paidAt
            ? `Paid ${formatDate(i.paidAt.slice(0, 10))}`
            : `Due ${formatDate(i.dueDate)}`
        }
        right={
          <>
            <Text variant="heading">{formatCents(i.totalCents)}</Text>
            <Pill {...pill} />
          </>
        }
        last={last && !payable}
      />
      {payable ? (
        <View style={[styles.payRow, !last && styles.divider]}>
          {error ? <Notice tone="danger" message={error} /> : null}
          <Button
            title={confirming ? `Confirm ${formatCents(i.totalCents)} from your bank` : 'Pay now'}
            variant={confirming ? 'primary' : 'secondary'}
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

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payRow: { paddingVertical: spacing.sm, gap: spacing.sm },
  divider: { borderBottomWidth: border.thin, borderBottomColor: colors.ink },
});
