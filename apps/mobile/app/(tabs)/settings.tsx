import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';

import { Button, Card, ListRow, Pill, Screen, Text } from '@/components';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { useBankLinks } from '@/lib/queries';

export default function Settings() {
  const { user, signOut } = useAuth();
  const { business, businesses } = useBusiness();
  const links = useBankLinks(business?.id);

  return (
    <Screen title="Settings">
      <Card>
        <Text variant="heading">{user?.fullName}</Text>
        <Text variant="body" tone="muted">
          {user?.email}
        </Text>
      </Card>

      <Card>
        <Text variant="heading">Businesses</Text>
        {businesses.map((b, idx) => (
          <ListRow
            key={b.id}
            title={b.dba ?? b.legalName}
            subtitle={`${b.address.city}, ${b.address.state} · ${formatCents(b.statedMonthlyRevenueCents, { showCents: false })}/mo stated`}
            right={
              <Pill
                label={b.status.charAt(0) + b.status.slice(1).toLowerCase()}
                tone={b.status === 'ACTIVE' ? 'paid' : 'neutral'}
              />
            }
            last={idx === businesses.length - 1}
          />
        ))}
        <Button
          title="Add a business"
          variant="secondary"
          onPress={() => router.push('/business/new')}
        />
      </Card>

      <Card>
        <Text variant="heading">Bank accounts</Text>
        {(links.data ?? []).length === 0 ? (
          <Text tone="muted">
            No accounts connected for {business?.dba ?? business?.legalName ?? 'this business'}.
          </Text>
        ) : (
          links.data!.map((l, idx) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Ending ${l.accountMask}${l.availableBalanceCents !== null ? ` · ${formatCents(l.availableBalanceCents, { showCents: false })} available` : ''}`}
              right={
                <Pill
                  label={l.status === 'LINKED' ? 'Linked' : l.status}
                  tone={l.status === 'LINKED' ? 'paid' : 'late'}
                />
              }
              last={idx === links.data!.length - 1}
            />
          ))
        )}
        <Button
          title="Connect an account"
          variant="secondary"
          onPress={() => router.push('/bank/connect')}
        />
      </Card>

      <Card tone="alt">
        <Text variant="caption" tone="muted">
          API
        </Text>
        <Text variant="body">{API_URL}</Text>
        <Text variant="caption" tone="muted">
          Set EXPO_PUBLIC_API_URL to point the app at another server.
        </Text>
      </Card>

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
    </Screen>
  );
}
