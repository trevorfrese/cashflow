import { formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, EmptyState, Notice, Pill, Screen, Text, TitleRow } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { healthPill, pendingActions, trustLabel } from '@/lib/connections';
import { formatDate } from '@/lib/forms';
import { useConnections, useDisconnect, useVerifySeat } from '@/lib/queries';
import { spacing } from '@/theme';

/**
 * Every data connection with how it was made, whether it is healthy, what it verified, and
 * anything the owner needs to do. The server decides all of it; this screen only says it.
 */
export default function Connections() {
  const { business, isLoading: businessLoading } = useBusiness();
  const list = useConnections(business?.id);
  const verify = useVerifySeat();
  const disconnect = useDisconnect();
  const actions = pendingActions(list.data);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
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
          variant={actions.length > 0 ? 'secondary' : 'azure'}
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
          {/* Contact support has no in-app channel yet, so the message stands on its own. */}
          {a.code === 'CONTACT_SUPPORT' ? null : (
            <Button
              title={a.code === 'RECONNECT' ? 'Reconnect' : 'Connect an account'}
              size="sm"
              onPress={() => act(a.code, a.connectionId)}
            />
          )}
        </Card>
      ))}
      {!business && !businessLoading ? (
        <Card>
          <Text variant="heading">Set up your business first</Text>
          <Text variant="body" tone="muted">
            Connections belong to a business. Add yours, then connect its bank account.
          </Text>
          <Button
            title="Set up your business"
            icon="arrow-right"
            onPress={() => router.push('/business/new')}
          />
        </Card>
      ) : null}
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
            <View style={styles.titleBlock}>
              <TitleRow
                title={c.name}
                variant="heading"
                pill={<Pill label={pill.label} tone={pill.tone} />}
              />
              {c.detail !== c.name ? (
                <Text variant="caption" tone="muted">
                  {c.detail}
                </Text>
              ) : null}
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
                {`Last updated ${formatDate(c.lastPulledAt.slice(0, 10))}`}
              </Text>
            ) : null}
            <View style={styles.buttons}>
              {c.accessMethod === 'DELEGATED_SEAT' && c.status !== 'DISCONNECTED' ? (
                <Button
                  title="Check connection"
                  size="sm"
                  onPress={() => verify.mutate(c.id)}
                  loading={verify.isPending && verify.variables === c.id}
                />
              ) : null}
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
              {c.status !== 'DISCONNECTED' && confirmDisconnect !== c.id ? (
                <Button
                  title="Disconnect"
                  size="sm"
                  variant="text"
                  onPress={() => setConfirmDisconnect(c.id)}
                />
              ) : null}
            </View>
            {confirmDisconnect === c.id ? (
              <View style={styles.confirm}>
                <Text variant="body">
                  {`Stop using ${c.name}? We stop reading it right away. A decision that needs it may ask you to connect again.`}
                </Text>
                <View style={styles.buttons}>
                  <Button
                    title="Yes, disconnect"
                    size="sm"
                    variant="danger"
                    onPress={() =>
                      disconnect.mutate(c.id, { onSettled: () => setConfirmDisconnect(null) })
                    }
                    loading={disconnect.isPending && disconnect.variables === c.id}
                  />
                  <Button
                    title="Keep it"
                    size="sm"
                    variant="text"
                    onPress={() => setConfirmDisconnect(null)}
                  />
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}
      {business ? (
        <Text variant="caption" tone="muted">
          {`Monthly revenue you told us: ${formatCents(business.statedMonthlyRevenueCents, { showCents: false })}.`}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleBlock: { gap: 2 },
  confirm: { gap: spacing.sm },
  // Stacked full width: the main action first, so nothing wraps into a ragged row.
  buttons: { gap: spacing.sm, marginTop: spacing.xs },
});
