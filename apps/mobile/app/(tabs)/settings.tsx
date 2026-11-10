import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, ListRow, Pill, Screen, Text } from '@/components';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { useBankLinks } from '@/lib/queries';
import { spacing } from '@/theme';

export default function Settings() {
  const { user, signOut } = useAuth();
  const { business, businesses } = useBusiness();
  const links = useBankLinks(business?.id);

  return (
    <Screen title="Settings">
      <Card style={styles.profile}>
        <Avatar name={user?.fullName} size={52} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="heading">{user?.fullName}</Text>
          <Text variant="body" tone="muted">
            {user?.email}
          </Text>
        </View>
      </Card>

      <Card>
        <Text variant="heading">Businesses</Text>
        {businesses.map((b, idx) => (
          <ListRow
            key={b.id}
            title={b.dba ?? b.legalName}
            subtitle={`${formatCents(b.statedMonthlyRevenueCents, { showCents: false })} a month`}
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
          size="sm"
          onPress={() => router.push('/business/new')}
        />
      </Card>

      <Card>
        <Text variant="heading">Bank accounts</Text>
        {(links.data ?? []).length === 0 ? (
          <Text tone="muted">None connected yet.</Text>
        ) : (
          links.data!.map((l, idx) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Ending ${l.accountMask}`}
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
          variant="azure"
          size="sm"
          onPress={() => router.push('/bank/connect')}
        />
      </Card>

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
        API {API_URL}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
