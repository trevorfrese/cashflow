import { CommercePlatform, COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ChoiceChips, Notice, Screen, Text } from '@/components';
import { useDevWalkthrough } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useApproveSandboxOAuth } from '@/lib/queries';
import { spacing } from '@/theme';

/** What the sandbox platform account looks like. Keywords from apps/api/README.md. */
const SCENARIOS = [
  { value: 'healthy', label: 'Healthy', blurb: 'Pays out to your connected bank, sales match.' },
  {
    value: 'healthy_payout_elsewhere',
    label: 'Pays out elsewhere',
    blurb: 'Payouts go to an account you have not connected.',
  },
  {
    value: 'healthy_owner_mismatch',
    label: 'Another business',
    blurb: 'The account is in a different legal name.',
  },
  { value: 'healthy_new_account', label: 'New account', blurb: 'Opened 45 days ago.' },
  {
    value: 'healthy_unsettled',
    label: 'Sales not paid out',
    blurb: 'Sales well above what is paid out.',
  },
] as const;
type ScenarioValue = (typeof SCENARIOS)[number]['value'];

/**
 * The sandbox stand-in for the platform's own consent page. In production the owner is on the
 * platform's site here, signed in with their own password, which CashFlow never sees. The
 * page sends them back with a code, which the app hands to CashFlow to finish connecting.
 */
export default function SandboxAuthorize() {
  const params = useLocalSearchParams<{ state: string; platform: string; next?: string }>();
  const platform = CommercePlatform.safeParse(params.platform).data ?? 'SQUARE';
  const name = COMMERCE_PLATFORM_LABELS[platform];
  const preset = useDevWalkthrough();
  const presetScenario = preset?.pos?.platform === platform ? preset.pos.scenario : null;
  const [scenario, setScenario] = useState<ScenarioValue>('healthy');
  const [error, setError] = useState<string | null>(null);
  const approve = useApproveSandboxOAuth();

  const finish = async (ok: boolean) => {
    setError(null);
    try {
      await approve.mutateAsync({
        state: params.state,
        scenario: presetScenario ?? scenario,
        approve: ok,
      });
      if (params.next === 'application') router.replace('/application/new');
      else router.replace('/connections');
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <Screen
      back
      title={`${name} (sandbox)`}
      subtitle={`This page stands in for ${name}'s own sign-in and approval page.`}
      footer={
        <View style={styles.buttons}>
          <Button
            title="Approve read-only access"
            variant="azure"
            size="lg"
            onPress={() => void finish(true)}
            loading={approve.isPending}
          />
          <Button title="Decline" variant="text" onPress={() => void finish(false)} />
        </View>
      }
    >
      {error ? <Notice tone="danger" message={error} /> : null}
      <Card>
        <Text variant="heading">CashFlow would like to</Text>
        <Text variant="body">• See your sales, refunds and payouts</Text>
        <Text variant="body">• See your business name and the bank account payouts go to</Text>
        <Text variant="body" tone="muted">
          It cannot take payments, issue refunds, or change your account.
        </Text>
      </Card>
      {presetScenario ? (
        <Notice
          tone="info"
          title="Dev persona"
          message={`${preset!.summary} Scenario: ${presetScenario}.`}
        />
      ) : (
        <View style={styles.group}>
          <Text variant="label">Sandbox account to simulate</Text>
          <ChoiceChips options={SCENARIOS} value={scenario} onChange={setScenario} />
          <Text variant="body" tone="muted">
            {SCENARIOS.find((s) => s.value === scenario)!.blurb}
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.smd },
  buttons: { gap: spacing.sm },
});
