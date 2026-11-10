import { formatCents } from '@cashflow/shared';
import { StyleSheet, View } from 'react-native';

import { Card, EmptyState, ListRow, Pill, Screen, Text, statusPill } from '@/components';
import { useBusiness } from '@/lib/business';
import { formatDate } from '@/lib/forms';
import { usePayouts, useRentPlans, useRepayments } from '@/lib/queries';
import { border, colors, hardShadow, spacing } from '@/theme';

type Entry = { id: string; date: string; title: string; amountCents: number; status: string };

export default function History() {
  const { business } = useBusiness();
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status === 'ACTIVE') ?? plans.data?.[0];
  const repayments = useRepayments(plan?.id);
  const payouts = usePayouts(plan?.id);

  const entries: Entry[] = [
    ...(payouts.data ?? [])
      .filter((p) => p.status === 'PAID' || p.status === 'FAILED')
      .map((p) => ({
        id: p.id,
        date: (p.paidAt ?? p.scheduledFor).slice(0, 10),
        title: 'To your landlord',
        amountCents: p.amountCents,
        status: p.status,
      })),
    ...(repayments.data ?? []).map((r) => ({
      id: r.id,
      date: r.createdAt.slice(0, 10),
      title: 'Repayment',
      amountCents: r.amountCents,
      status: r.status,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalRepaid = (repayments.data ?? [])
    .filter((r) => r.status === 'SUCCEEDED')
    .reduce((s, r) => s + r.amountCents, 0);
  const totalPaidOut = (payouts.data ?? [])
    .filter((p) => p.status === 'PAID')
    .reduce((s, p) => s + p.amountCents, 0);

  if (!plans.isLoading && !plan) {
    return (
      <Screen title="History">
        <EmptyState
          title="No activity yet"
          message="Payments to your landlord and your repayments show up here."
        />
      </Screen>
    );
  }

  return (
    <Screen title="History">
      <View style={styles.tiles}>
        <View style={[styles.tile, { backgroundColor: colors.gold }, hardShadow('m')]}>
          <Text variant="label">To landlord</Text>
          <Text variant="number" style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatCents(totalPaidOut, { showCents: false })}
          </Text>
        </View>
        <View style={[styles.tile, hardShadow('m')]}>
          <Text variant="label">Repaid</Text>
          <Text variant="number" style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
            {formatCents(totalRepaid, { showCents: false })}
          </Text>
        </View>
      </View>

      <Card>
        {entries.length === 0 ? (
          <Text tone="muted">Nothing yet.</Text>
        ) : (
          entries.map((e, idx) => (
            <ListRow
              key={e.id}
              title={formatCents(e.amountCents, { showCents: e.title === 'Repayment' })}
              subtitle={`${e.title} · ${formatDate(e.date)}`}
              right={<Pill {...statusPill(e.status)} />}
              last={idx === entries.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
