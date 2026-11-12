import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';

import { Button, Card, ListRow, Pill, Screen, Text, statusPill } from '@/components';
import { useBusiness } from '@/lib/business';
import { useBankLinks } from '@/lib/queries';

export default function BankSettings() {
  const { business } = useBusiness();
  const links = useBankLinks(business?.id);
  const rows = links.data ?? [];
  return (
    <Screen
      back
      title="Bank accounts"
      subtitle={business?.dba ?? business?.legalName}
      footer={
        <Button
          title="Connect an account"
          variant="azure"
          onPress={() => router.push('/bank/connect')}
        />
      }
    >
      <Card>
        {rows.length === 0 ? (
          <Text tone="muted">None connected yet.</Text>
        ) : (
          rows.map((l, idx) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Ending ${l.accountMask}${l.availableBalanceCents !== null ? ` · ${formatCents(l.availableBalanceCents, { showCents: false })} available` : ''}`}
              right={<Pill {...statusPill(l.status)} />}
              last={idx === rows.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}
