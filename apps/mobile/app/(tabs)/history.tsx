import { formatCents } from '@cashflow/shared';

import { Card, EmptyState, ListRow, Pill, Screen, Text, statusPill } from '@/components';
import { useBusiness } from '@/lib/business';
import { formatDate } from '@/lib/forms';
import { usePayouts, useRentPlans, useRepayments } from '@/lib/queries';

export default function History() {
  const { business } = useBusiness();
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status === 'ACTIVE') ?? plans.data?.[0];
  const repayments = useRepayments(plan?.id);
  const payouts = usePayouts(plan?.id);

  const paidOut = (payouts.data ?? [])
    .filter((p) => p.status === 'PAID' || p.status === 'FAILED')
    .sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : -1));
  const collected = [...(repayments.data ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  const totalRepaid = collected
    .filter((r) => r.status === 'SUCCEEDED')
    .reduce((s, r) => s + r.amountCents, 0);
  const totalPaidOut = paidOut
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
      <Card tone="alt">
        <Text variant="caption" tone="muted">
          Since you started
        </Text>
        <Text variant="heading">
          {formatCents(totalPaidOut, { showCents: false })} paid to your landlord
        </Text>
        <Text variant="body" tone="muted">
          {formatCents(totalRepaid)} repaid across{' '}
          {collected.filter((r) => r.status === 'SUCCEEDED').length} payments
        </Text>
      </Card>

      <Card>
        <Text variant="heading">Your repayments</Text>
        {collected.length === 0 ? (
          <Text tone="muted">No repayments yet.</Text>
        ) : (
          collected.map((r, idx) => (
            <ListRow
              key={r.id}
              title={formatCents(r.amountCents)}
              subtitle={`${formatDate(r.createdAt.slice(0, 10))}${r.failureReason ? ` · ${r.failureReason}` : ''}`}
              right={<Pill {...statusPill(r.status)} />}
              last={idx === collected.length - 1}
            />
          ))
        )}
      </Card>

      <Card>
        <Text variant="heading">Landlord payouts</Text>
        {paidOut.length === 0 ? (
          <Text tone="muted">No payouts yet.</Text>
        ) : (
          paidOut.map((p, idx) => (
            <ListRow
              key={p.id}
              title={formatCents(p.amountCents, { showCents: false })}
              subtitle={
                p.paidAt
                  ? `Paid ${formatDate(p.paidAt.slice(0, 10))}`
                  : `Scheduled ${formatDate(p.scheduledFor)}${p.failureReason ? ` · ${p.failureReason}` : ''}`
              }
              right={<Pill {...statusPill(p.status)} />}
              last={idx === paidOut.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}
