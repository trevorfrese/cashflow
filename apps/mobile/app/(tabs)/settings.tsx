import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Avatar, Button, Card, Icon, ListRow, Screen, Text } from '@/components';
import { API_URL } from '@/lib/api';
import { DEV_TOOLS } from '@/dev/flag';
import { useAuth } from '@/lib/auth';
import { useBusiness } from '@/lib/business';
import { formatMoney, plural } from '@/lib/forms';
import { useBankLinks, useLeases, useRentPlans } from '@/lib/queries';
import { spacing } from '@/theme';

export default function Settings() {
  const { user, signOut } = useAuth();
  const { business, businesses } = useBusiness();
  const links = useBankLinks(business?.id);
  const leases = useLeases(business?.id);
  const plans = useRentPlans(business?.id);
  const plan = plans.data?.find((p) => p.status !== 'CLOSED') ?? null;
  const closed = !plan && (plans.data ?? []).some((p) => p.status === 'CLOSED');
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
          title={plan ? `Rent · ${formatMoney(plan.monthlyRentCents)}` : 'Rent'}
          subtitle={
            plan && lease
              ? plan.kind === 'PASS_THROUGH'
                ? `${lease.landlordName} · Free pass-through plan`
                : `${lease.landlordName} · ${plural(plan.installmentsPerMonth, 'payment')} a month${plan.status === 'PAUSED' ? ' · Paused' : ''}`
              : closed
                ? 'Your plan is closed'
                : 'No rent plan yet'
          }
          right={chevron}
          onPress={() => router.push('/settings/rent')}
        />
        <ListRow
          title="Businesses"
          subtitle={`${plural(businesses.length, 'business', 'businesses')} on this account`}
          right={chevron}
          onPress={() => router.push('/settings/businesses')}
        />
        <ListRow
          title="Bank accounts"
          subtitle={`${plural((links.data ?? []).filter((l) => l.status === 'LINKED').length, 'account')} connected for ${business?.dba ?? business?.legalName ?? 'this business'}`}
          right={chevron}
          onPress={() => router.push('/settings/banks')}
        />
        <ListRow
          title="Connected data"
          subtitle="Bank and point of sale connections, and how each was made"
          right={chevron}
          onPress={() => router.push('/connections')}
          last
        />
      </Card>

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
      {DEV_TOOLS ? (
        <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
          API {API_URL}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
