import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Icon, ListRow, Screen, Text } from '@/components';
import { API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { useBankLinks, useLeases, useRentPlans } from '@/lib/queries';
import { spacing } from '@/theme';

export default function Settings() {
  const { user, signOut } = useAuth();
  const { business, businesses } = useBusiness();
  const links = useBankLinks(business?.id);
  const leases = useLeases(business?.id);
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status !== 'CLOSED') ?? null;
  const lease = leases.data?.find((l) => l.id === plan?.leaseId) ?? null;
  const chevron = <Icon name="chevron-right" size={20} />;

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
        <ListRow
          title={
            plan ? `Rent · ${formatCents(plan.monthlyRentCents, { showCents: false })}` : 'Rent'
          }
          subtitle={
            plan && lease
              ? `${lease.landlordName} · ${plan.installmentsPerMonth} a month · ${plan.status === 'PAUSED' ? 'Paused' : 'Active'}`
              : 'No rent plan yet'
          }
          right={chevron}
          onPress={() => router.push('/settings/rent')}
        />
        <ListRow
          title="Businesses"
          subtitle={`${businesses.length} on this account`}
          right={chevron}
          onPress={() => router.push('/settings/businesses')}
        />
        <ListRow
          title="Bank accounts"
          subtitle={`${(links.data ?? []).length} connected for ${business?.dba ?? business?.legalName ?? 'this business'}`}
          right={chevron}
          onPress={() => router.push('/settings/banks')}
          last
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
