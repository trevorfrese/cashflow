import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, EmptyState, Notice, Pill, Screen, Text } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { healthPill, pendingActions, trustLabel } from '@/lib/connections';
import { useConnections, useDisconnect, useVerifySeat } from '@/lib/queries';
import { spacing } from '@/theme';

/**
 * Every data connection with how it was made, whether it is healthy, what it verified, and
 * anything the owner needs to do. The server decides all of it; this screen only says it.
 */
export default function Connections() {
  const { business } = useBusiness();
  const list = useConnections(business?.id);
  const verify = useVerifySeat();
  const disconnect = useDisconnect();
  const actions = pendingActions(list.data);
  const error = list.error ?? verify.error ?? disconnect.error;

  const act = (code: string, connectionId: string | null) => {
    if (code === 'CONNECT_PAYOUT_ACCOUNT' || code === 'CONNECT_BANK' || code === 'SHARE_ACCOUNTS') {
      router.push({ pathname: '/bank/connect', params: { next: 'connections' } });
    } else if (code === 'RECONNECT' && connectionId) {
      const c = list.data?.connections.find((x) => x.id === connectionId);
      if (c?.kind === 'BANK')
        router.push({ pathname: '/bank/connect', params: { next: 'connections' } });
      else if (c?.platform)
        router.push({ pathname: '/connections/pos', params: { platform: c.platform } });
    }
  };

  return (
    <Screen
      back
      title="Connected data"
      subtitle="How we see your sales and cash flow. Read-only, always."
      footer={
        <Button
          title="Connect a point of sale"
          variant="azure"
          icon="arrow-right"
          onPress={() => router.push('/connections/pos')}
          disabled={!business}
        />
      }
    >
      {error ? <Notice tone="danger" message={describeError(error)} /> : null}
      {actions.map((a) => (
        <Card key={a.code}>
          <Notice tone="warning" title="Action needed" message={a.message} />
          <Button
            title={
              a.code === 'RECONNECT'
                ? 'Reconnect'
                : a.code === 'CONTACT_SUPPORT'
                  ? 'Contact support'
                  : 'Connect an account'
            }
            size="sm"
            onPress={() => act(a.code, a.connectionId)}
          />
        </Card>
      ))}
      {list.data && list.data.connections.length === 0 ? (
        <EmptyState
          title="Nothing connected yet"
          message="Connect your business bank account to apply."
        />
      ) : null}
      {list.data?.connections.map((c) => {
        const pill = healthPill(c);
        return (
          <Card key={c.id}>
            <View style={styles.header}>
              <View style={styles.titleBlock}>
                <Text variant="heading">{c.name}</Text>
                <Text variant="caption" tone="muted">
                  {c.detail}
                </Text>
              </View>
              <Pill label={pill.label} tone={pill.tone} />
            </View>
            <Text variant="body" tone="muted">
              {c.methodDescription}
            </Text>
            {c.status === 'LINKED' ? (
              <Text variant="caption">{trustLabel(c.trustTier)}</Text>
            ) : null}
            {c.checks.map((check) => (
              <Text key={check.label} variant="body" tone={check.ok ? 'success' : 'danger'}>
                {check.ok ? '✓' : '!'} {check.label}
              </Text>
            ))}
            {c.lastPulledAt ? (
              <Text variant="caption" tone="muted">
                Last updated {new Date(c.lastPulledAt).toLocaleDateString()}
              </Text>
            ) : null}
            <View style={styles.buttons}>
              {c.accessMethod === 'DELEGATED_SEAT' && c.status === 'PENDING' ? (
                <Button
                  title="See the steps"
                  size="sm"
                  variant="secondary"
                  onPress={() =>
                    router.push({ pathname: '/connections/seat', params: { connectionId: c.id } })
                  }
                />
              ) : null}
              {c.accessMethod === 'DELEGATED_SEAT' && c.status !== 'DISCONNECTED' ? (
                <Button
                  title="Check connection"
                  size="sm"
                  onPress={() => verify.mutate(c.id)}
                  loading={verify.isPending && verify.variables === c.id}
                />
              ) : null}
              {c.status !== 'DISCONNECTED' ? (
                <Button
                  title="Disconnect"
                  size="sm"
                  variant="text"
                  onPress={() => disconnect.mutate(c.id)}
                  loading={disconnect.isPending && disconnect.variables === c.id}
                />
              ) : null}
            </View>
          </Card>
        );
      })}
      {business ? (
        <Text variant="caption" tone="muted">
          Stated revenue on file:{' '}
          {formatCents(business.statedMonthlyRevenueCents, { showCents: false })} a month.
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  titleBlock: { flex: 1 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
});
