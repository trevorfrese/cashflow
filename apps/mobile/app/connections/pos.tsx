import { CommercePlatform, COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ChoiceChips, Notice, Screen, Text } from '@/components';
import { useDevWalkthrough } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { connectsBySeat, methodPromise } from '@/lib/connections';
import { useStartOAuth } from '@/lib/queries';
import { spacing } from '@/theme';

const PLATFORMS = CommercePlatform.options.map((value) => ({
  value,
  label: COMMERCE_PLATFORM_LABELS[value],
}));

/**
 * Pick the point of sale. Platforms with an API send the owner to approve read-only access on
 * the platform's own site (in the sandbox, CashFlow's stand-in for it). Toast has no such API:
 * the owner adds CashFlow's read-only reports user instead.
 */
export default function ConnectPointOfSale() {
  const params = useLocalSearchParams<{ platform?: string; next?: string }>();
  const { business } = useBusiness();
  const preset = useDevWalkthrough();
  const initial =
    CommercePlatform.safeParse(params.platform).data ?? preset?.pos?.platform ?? 'SQUARE';
  const [platform, setPlatform] = useState<CommercePlatform>(initial);
  const [error, setError] = useState<string | null>(null);
  const start = useStartOAuth();
  const name = COMMERCE_PLATFORM_LABELS[platform];

  const go = async () => {
    if (!business) return;
    setError(null);
    if (connectsBySeat(platform)) {
      router.replace({
        pathname: '/connections/seat',
        params: { platform, next: params.next ?? '' },
      });
      return;
    }
    try {
      const started = await start.mutateAsync({ businessId: business.id, platform });
      if (started.sandbox) {
        router.replace({
          pathname: '/connections/authorize',
          params: { state: started.state, platform, next: params.next ?? '' },
        });
      } else {
        // A real platform: open its consent page; it redirects back to the app.
        setError('This build only connects sandbox platforms.');
      }
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <Screen
      back
      title="Connect your point of sale"
      subtitle="Sales at the source let us verify revenue before it reaches your bank."
      footer={
        <Button
          title={connectsBySeat(platform) ? `Set up ${name} access` : `Continue to ${name}`}
          variant="azure"
          size="lg"
          icon="arrow-right"
          onPress={() => void go()}
          loading={start.isPending}
          disabled={!business}
        />
      }
    >
      {error ? <Notice tone="danger" message={error} /> : null}
      <View style={styles.group}>
        <Text variant="label">Platform</Text>
        <ChoiceChips options={PLATFORMS} value={platform} onChange={setPlatform} />
      </View>
      <Notice tone="info" title="How this works" message={methodPromise(platform)} />
      <Text variant="body" tone="muted">
        We only ask for read access to sales, payouts and your account details. We can never take
        payments, issue refunds, or change anything on your account.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.smd },
});
