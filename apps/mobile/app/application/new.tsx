import { CreateApplicationRequest, formatCents } from '@cashflow/shared';
import { Link, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, ListRow, Notice, Pill, Screen, Text, TextField } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { centsToDollarsInput, dollarsToCents, monthsSince } from '@/lib/forms';
import { useBankLinks, useSubmitApplication } from '@/lib/queries';
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
  const submit = useSubmitApplication();
  const sameDraft = draft.businessId !== null && draft.businessId === business?.id;
  const [revenue, setRevenue] = useState(sameDraft ? draft.revenue : '');
  const [months, setMonths] = useState(sameDraft ? draft.months : '');
  const [rent, setRent] = useState(sameDraft ? draft.rent : '');
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
      title="Apply for rent advances"
      subtitle="Underwriting looks at your bank account, not a credit score. Decisions are instant."
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
        <View style={styles.cardHeader}>
          <Text variant="heading">Bank account</Text>
          <Link href={{ pathname: '/bank/connect', params: { next: 'application' } }}>
            <Text variant="bodyStrong" tone="link">
              {linked.length > 0 ? 'Add another' : 'Connect'}
            </Text>
          </Link>
        </View>
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
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
});
