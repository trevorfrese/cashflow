import { formatCents } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ChoiceChips, ListRow, Notice, Pill, Screen, Text } from '@/components';
import { useDevWalkthrough } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { centsToDollarsInput } from '@/lib/forms';
import { useBankLinks, useCreateBankLink } from '@/lib/queries';
import { spacing } from '@/theme';

/**
 * In production this screen would open Plaid Link. In the sandbox it lets you pick what kind
 * of bank history the fake bank should return, so every underwriting outcome can be demoed.
 */
const SCENARIOS = [
  { value: 'healthy', label: 'Healthy', blurb: 'Steady sales, modest growth, comfortable buffer.' },
  { value: 'growing', label: 'Growing fast', blurb: 'Revenue up about 45% over the year.' },
  { value: 'seasonal', label: 'Seasonal', blurb: 'Big summer, quiet winter.' },
  { value: 'thin_margin', label: 'Thin margins', blurb: 'Spending runs close to revenue.' },
  {
    value: 'heavy_debt',
    label: 'Existing debt',
    blurb: 'SBA loan plus a daily merchant cash advance.',
  },
  { value: 'volatile', label: 'Volatile', blurb: 'Large month to month swings.' },
  { value: 'low_balance', label: 'Low balance', blurb: 'Healthy flows, almost no cash on hand.' },
  { value: 'overdrafts', label: 'Overdrafts', blurb: 'Repeated NSF fees in the last 90 days.' },
  { value: 'declining', label: 'Declining', blurb: 'Revenue stepped down sharply this year.' },
  { value: 'new_business', label: 'New business', blurb: 'Only four months of history.' },
] as const;
type ScenarioValue = (typeof SCENARIOS)[number]['value'];

export default function ConnectBank() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const { business } = useBusiness();
  const links = useBankLinks(business?.id);
  const create = useCreateBankLink();
  // Dev menu only: a fresh applicant persona preselects the scenario that leads to its
  // outcome. The screen says so, and any other scenario can still be picked.
  const preset = useDevWalkthrough();
  const presetScenario = SCENARIOS.find((s) => s.value === preset?.bankScenario)?.value;
  const [scenario, setScenario] = useState<ScenarioValue>(presetScenario ?? 'healthy');
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!business) return;
    setError(null);
    const revenue = centsToDollarsInput(business.statedMonthlyRevenueCents).split('.')[0];
    try {
      await create.mutateAsync({
        businessId: business.id,
        // The preset's own token is stable, so its decision is the same on every run.
        publicToken:
          preset && scenario === presetScenario
            ? preset.bankPublicToken
            : `mock_${scenario}_rev_${revenue}_${Date.now()}`,
      });
      if (next === 'application') router.replace('/application/new');
      else router.back();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const chosen = SCENARIOS.find((s) => s.value === scenario)!;

  return (
    <Screen
      back
      title="Connect your bank"
      subtitle="Pick the account history the sandbox bank should return."
      footer={
        <Button
          title="Connect bank"
          variant="azure"
          size="lg"
          icon="arrow-right"
          onPress={() => void connect()}
          loading={create.isPending}
          disabled={!business}
        />
      }
    >
      {error ? <Notice tone="danger" message={error} /> : null}
      {preset && presetScenario ? (
        <Notice
          tone="info"
          title={`Dev persona: ${SCENARIOS.find((s) => s.value === presetScenario)!.label} is preselected`}
          message={`${preset.summary} Pick another history to see a different decision.`}
        />
      ) : null}
      <View style={styles.group}>
        <Text variant="label">Account history to simulate</Text>
        <ChoiceChips options={SCENARIOS} value={scenario} onChange={setScenario} />
        <Text variant="body" tone="muted">
          {chosen.blurb}
        </Text>
      </View>
      {links.data && links.data.length > 0 ? (
        <Card>
          <Text variant="heading">Connected accounts</Text>
          {links.data.map((l, i) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Account ending ${l.accountMask}`}
              right={
                <>
                  <Pill
                    label={l.status === 'LINKED' ? 'Linked' : l.status}
                    tone={l.status === 'LINKED' ? 'paid' : 'late'}
                  />
                  {l.availableBalanceCents !== null ? (
                    <Text variant="caption" tone="muted">
                      {formatCents(l.availableBalanceCents, { showCents: false })}
                    </Text>
                  ) : null}
                </>
              }
              last={i === links.data!.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.smd },
});
