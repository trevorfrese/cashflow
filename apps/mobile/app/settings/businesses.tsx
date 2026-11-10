import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';

import { Button, Card, ListRow, Pill, Screen, Text } from '@/components';
import { useBusiness } from '@/lib/business';

export default function BusinessSettings() {
  const { business, businesses, select } = useBusiness();
  return (
    <Screen
      back
      title="Businesses"
      subtitle="Tap one to make it the business you see on the home screen."
      footer={
        <Button
          title="Add a business"
          variant="secondary"
          onPress={() => router.push('/business/new')}
        />
      }
    >
      <Card>
        {businesses.length === 0 ? (
          <Text tone="muted">No businesses yet.</Text>
        ) : (
          businesses.map((b, idx) => (
            <ListRow
              key={b.id}
              title={b.dba ?? b.legalName}
              subtitle={`${formatCents(b.statedMonthlyRevenueCents, { showCents: false })} a month${b.id === business?.id ? ' · Selected' : ''}`}
              right={
                <Pill
                  label={b.status.charAt(0) + b.status.slice(1).toLowerCase()}
                  tone={b.status === 'ACTIVE' ? 'paid' : 'neutral'}
                />
              }
              onPress={() => select(b.id)}
              last={idx === businesses.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}
