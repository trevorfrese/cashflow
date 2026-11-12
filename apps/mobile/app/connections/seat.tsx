import { CommercePlatform, COMMERCE_PLATFORM_LABELS, type SeatInvitation } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { Button, Card, Notice, Screen, Text } from '@/components';
import { useDevWalkthrough } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { useConnections, useCreateSeatInvitation, useVerifySeat } from '@/lib/queries';

/**
 * Toast and other platforms without an API: the owner adds CashFlow's own read-only reports
 * user to their account. CashFlow signs in as that user, never as the owner.
 */
export default function SeatInstructions() {
  const params = useLocalSearchParams<{
    platform?: string;
    connectionId?: string;
    next?: string;
  }>();
  const { business } = useBusiness();
  const connections = useConnections(business?.id);
  const preset = useDevWalkthrough();
  const create = useCreateSeatInvitation();
  const verify = useVerifySeat();
  const [invitation, setInvitation] = useState<SeatInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const platform = CommercePlatform.safeParse(params.platform).data ?? 'TOAST';
  const existing = connections.data?.connections.find(
    (c) => c.id === params.connectionId || (c.platform === platform && c.status === 'PENDING'),
  );
  const connectionId = invitation?.connection.id ?? existing?.id ?? null;
  const name = COMMERCE_PLATFORM_LABELS[existing?.platform ?? platform];

  useEffect(() => {
    if (!business || invitation || existing || create.isPending || connections.isLoading) return;
    create
      .mutateAsync({
        businessId: business.id,
        platform,
        ...(preset?.pos?.platform === platform ? { scenario: preset.pos.scenario } : {}),
      })
      .then(setInvitation)
      .catch((e: unknown) => setError(describeError(e)));
  }, [business, invitation, existing, create, connections.isLoading, platform, preset]);

  const check = async () => {
    if (!connectionId) return;
    setError(null);
    try {
      const c = await verify.mutateAsync(connectionId);
      if (c.status === 'LINKED') {
        if (params.next === 'application') router.replace('/application/new');
        else router.replace('/connections');
      } else {
        setError(
          c.health === 'ERROR'
            ? 'We could not read your reports. Try again shortly.'
            : 'We do not see the CashFlow reports user yet. Check the steps and try again.',
        );
      }
    } catch (e) {
      setError(describeError(e));
    }
  };

  const steps = invitation?.steps ?? [
    `Sign in to ${name} as the account owner or an admin.`,
    'Add the CashFlow reports user as an employee with a reports-only role.',
    'Come back and tap Check connection.',
  ];

  return (
    <Screen
      back
      title={`Give CashFlow read-only access to ${name}`}
      subtitle={`${name} has no way to approve access directly, so you add our own reports user. We never see your password.`}
      footer={
        <Button
          title="Check connection"
          variant="azure"
          size="lg"
          onPress={() => void check()}
          loading={verify.isPending}
          disabled={!connectionId}
        />
      }
    >
      {error ? <Notice tone="warning" message={error} /> : null}
      <Card>
        <Text variant="label">Add this user</Text>
        <Text variant="bodyStrong" selectable>
          {invitation?.serviceUserEmail ?? existing?.seatServiceUser ?? 'CashFlow Reports'}
        </Text>
        <Text variant="body" tone="muted">
          Role: {invitation?.role ?? 'Read-only reports'}
        </Text>
      </Card>
      <Card>
        {steps.map((s, i) => (
          <Text key={s} variant="body">
            {i + 1}. {s}
          </Text>
        ))}
      </Card>
      <Text variant="caption" tone="muted">
        You can remove the CashFlow reports user from your {name} account at any time. Disconnecting
        here stops us using it immediately.
      </Text>
    </Screen>
  );
}
