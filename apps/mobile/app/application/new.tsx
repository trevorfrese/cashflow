import { CreateApplicationRequest, formatCents } from '@cashflow/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ListRow, Notice, Pill, Screen, Text, TextField } from '@/components';
import { APPLICATION_DISCLOSURE } from '@/lib/decision';
import { useDevWalkthrough } from '@/dev/DevTools';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { centsToDollarsInput, dollarsToCents, monthsSince } from '@/lib/forms';
import { useBankLinks, useConnections, useSubmitApplication } from '@/lib/queries';
import { spacing } from '@/theme';

/**
 * What the owner typed, kept across the detour to the bank connect screen. That screen
 * replaces this route, so component state alone would reset the form on the way back.
 */
const draft: { businessId: string | null; revenue: string; months: string; rent: string } = {
  businessId: null,
  revenue: '',
  months: '',
  rent: '',
};

export default function NewApplication() {
  const { business } = useBusiness();
  const links = useBankLinks(business?.id);
  const connections = useConnections(business?.id);
  const platforms = (connections.data?.connections ?? []).filter(
    (c) => c.kind === 'COMMERCE' && c.status !== 'DISCONNECTED',
  );
  const submit = useSubmitApplication();
  const sameDraft = draft.businessId !== null && draft.businessId === business?.id;
  // Dev menu only: a fresh applicant persona fills in the months and rent of its preset.
  const preset = useDevWalkthrough();
  const [revenue, setRevenue] = useState(sameDraft ? draft.revenue : '');
  const [months, setMonths] = useState(
    sameDraft ? draft.months : preset ? String(preset.timeInBusinessMonths) : '',
  );
  const [rent, setRent] = useState(
    sameDraft ? draft.rent : preset ? centsToDollarsInput(preset.requestedMonthlyRentCents) : '',
  );
  const [bankLinkId, setBankLinkId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (business) {
      setRevenue((v) => v || centsToDollarsInput(business.statedMonthlyRevenueCents));
      setMonths((v) => v || String(monthsSince(business.foundedOn)));
    }
  }, [business]);
  useEffect(() => {
    draft.businessId = business?.id ?? null;
    draft.revenue = revenue;
    draft.months = months;
    draft.rent = rent;
  }, [business?.id, revenue, months, rent]);
  useEffect(() => {
    const linked = links.data?.filter((l) => l.status === 'LINKED') ?? [];
    if (!bankLinkId && linked.length > 0) setBankLinkId(linked[linked.length - 1]!.id);
  }, [links.data, bankLinkId]);

  const onSubmit = async () => {
    if (!business) return;
    const revenueCents = dollarsToCents(revenue);
    const rentCents = dollarsToCents(rent);
    const next: Record<string, string> = {};
    if (revenueCents === null) next.revenue = 'Enter a dollar amount.';
    if (rentCents === null || rentCents === 0) next.rent = 'Enter your monthly rent.';
    if (!/^\d+$/.test(months.trim())) next.months = 'Whole months.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    const parsed = CreateApplicationRequest.safeParse({
      businessId: business.id,
      statedMonthlyRevenueCents: revenueCents,
      timeInBusinessMonths: Number(months),
      requestedMonthlyRentCents: rentCents,
      bankLinkId: bankLinkId ?? undefined,
    });
    if (!parsed.success) {
      setErrors({ form: parsed.error.issues[0]?.message ?? 'Check the form.' });
      return;
    }
    setErrors({});
    try {
      const app = await submit.mutateAsync(parsed.data);
      draft.businessId = null;
      router.replace({ pathname: '/application/[id]', params: { id: app.id } });
    } catch (e) {
      setErrors({ form: describeError(e) });
    }
  };

  const linked = links.data?.filter((l) => l.status === 'LINKED') ?? [];

  return (
    <Screen
      back
      step="Step 2 of 4"
      title="Apply to split your rent"
      subtitle="We look at your bank account, not your credit score. Decisions are instant."
      footer={
        <Button
          title="Submit application"
          size="lg"
          icon="arrow-right"
          onPress={() => void onSubmit()}
          loading={submit.isPending}
          disabled={!business}
        />
      }
    >
      {errors.form ? <Notice tone="danger" message={errors.form} /> : null}
      {preset ? (
        <Notice
          tone="info"
          title="Dev persona: months and rent are prefilled"
          message={preset.summary}
        />
      ) : null}
      {business ? (
        <Card tone="paper" shadow="none">
          <Text variant="label">Applying as</Text>
          <Text variant="heading">{business.dba ?? business.legalName}</Text>
        </Card>
      ) : null}
      <TextField
        label="Monthly revenue"
        value={revenue}
        onChangeText={setRevenue}
        prefix="$"
        keyboardType="decimal-pad"
        error={errors.revenue}
      />
      <TextField
        label="Months in business"
        value={months}
        onChangeText={setMonths}
        keyboardType="number-pad"
        error={errors.months}
      />
      <TextField
        label="Monthly rent"
        value={rent}
        onChangeText={setRent}
        prefix="$"
        keyboardType="decimal-pad"
        error={errors.rent}
        placeholder="6,200"
      />

      <Card>
        <Text variant="heading">Bank account</Text>
        {linked.length === 0 ? (
          <Text variant="body" tone="muted">
            No account connected yet. You can submit without one, but the decision will ask for it.
          </Text>
        ) : (
          linked.map((l, i) => (
            <ListRow
              key={l.id}
              title={l.institutionName}
              subtitle={`Ending ${l.accountMask}${l.availableBalanceCents !== null ? ` · ${formatCents(l.availableBalanceCents, { showCents: false })} available` : ''}`}
              onPress={() => setBankLinkId(l.id)}
              right={
                <Pill
                  label={bankLinkId === l.id ? 'Selected' : 'Use'}
                  tone={bankLinkId === l.id ? 'paid' : 'draft'}
                />
              }
              last={i === linked.length - 1}
            />
          ))
        )}
        <Button
          title={linked.length > 0 ? 'Add another bank account' : 'Connect a bank account'}
          variant={linked.length > 0 ? 'text' : 'secondary'}
          size="sm"
          onPress={() =>
            router.push({ pathname: '/bank/connect', params: { next: 'application' } })
          }
        />
      </Card>

      <Card>
        <Text variant="heading">Point of sale</Text>
        {platforms.length === 0 ? (
          <Text variant="body" tone="muted">
            Optional. Your sales at the source, matched to your bank deposits, count as a second
            source.
          </Text>
        ) : (
          platforms.map((c, i) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={c.detail}
              right={
                <Pill
                  label={c.status === 'PENDING' ? 'Waiting on you' : 'Connected'}
                  tone={c.status === 'PENDING' ? 'due' : 'paid'}
                />
              }
              onPress={
                c.status === 'PENDING'
                  ? () =>
                      router.push({
                        pathname: '/connections/seat',
                        params: { connectionId: c.id, next: 'application' },
                      })
                  : undefined
              }
              last={i === platforms.length - 1}
            />
          ))
        )}
        <Button
          title={platforms.length > 0 ? 'Add another point of sale' : 'Connect a point of sale'}
          variant={platforms.length > 0 ? 'text' : 'secondary'}
          size="sm"
          onPress={() =>
            router.push({ pathname: '/connections/pos', params: { next: 'application' } })
          }
        />
      </Card>

      <Card tone="paper" shadow="none">
        <Text variant="heading">{APPLICATION_DISCLOSURE.title}</Text>
        <View style={styles.points}>
          {APPLICATION_DISCLOSURE.points.map((p) => (
            <Text key={p} variant="body" tone="muted">
              {p}
            </Text>
          ))}
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  points: { gap: spacing.sm, paddingTop: spacing.xs },
});
