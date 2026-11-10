import type { Industry } from '@cashflow/shared';
import { CreateBusinessRequest } from '@cashflow/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ChoiceChips, Notice, Screen, Text, TextField } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { dollarsToCents, normalizeMonthInput } from '@/lib/forms';
import { useCreateBusiness } from '@/lib/queries';
import { spacing } from '@/theme';

const INDUSTRIES: ReadonlyArray<{ value: Industry; label: string }> = [
  { value: 'RESTAURANT', label: 'Restaurant or cafe' },
  { value: 'RETAIL', label: 'Retail' },
  { value: 'SALON', label: 'Salon or barber' },
  { value: 'FITNESS', label: 'Fitness or studio' },
  { value: 'PROFESSIONAL_SERVICES', label: 'Professional services' },
  { value: 'HEALTHCARE', label: 'Healthcare' },
  { value: 'OTHER', label: 'Other' },
];

export default function NewBusiness() {
  const create = useCreateBusiness();
  const { select } = useBusiness();
  const [form, setForm] = useState({
    legalName: '',
    dba: '',
    industry: null as Industry | null,
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    foundedOn: '',
    revenue: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    const revenueCents = dollarsToCents(form.revenue);
    const foundedOn = normalizeMonthInput(form.foundedOn);
    const candidate = {
      legalName: form.legalName.trim(),
      dba: form.dba.trim() || undefined,
      industry: form.industry,
      address: {
        line1: form.line1.trim(),
        line2: form.line2.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim().toUpperCase(),
        postalCode: form.postalCode.trim(),
      },
      foundedOn,
      statedMonthlyRevenueCents: revenueCents,
    };
    const parsed = CreateBusinessRequest.safeParse(candidate);
    const next: Record<string, string> = {};
    if (revenueCents === null) next.revenue = 'Enter a dollar amount.';
    if (!foundedOn) next.foundedOn = 'Use the format YYYY-MM.';
    if (!form.industry) next.industry = 'Pick the closest industry.';
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[issue.path.length - 1];
        if (key && !next[String(key)]) next[String(key)] = issue.message;
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const business = await create.mutateAsync(parsed.data!);
      select(business.id);
      router.replace('/(tabs)');
    } catch (e) {
      setErrors({ form: describeError(e) });
    }
  };

  return (
    <Screen
      title="Your business"
      subtitle="Tell us about the business whose rent you want to split."
      footer={
        <Button title="Save business" onPress={() => void submit()} loading={create.isPending} />
      }
    >
      {errors.form ? <Notice tone="danger" message={errors.form} /> : null}
      <TextField
        label="Legal name"
        value={form.legalName}
        onChangeText={set('legalName')}
        error={errors.legalName}
        placeholder="Blue Door Bakery LLC"
      />
      <TextField
        label="Doing business as (optional)"
        value={form.dba}
        onChangeText={set('dba')}
        placeholder="Blue Door Bakery"
      />
      <View style={styles.group}>
        <Text variant="caption" tone="muted" style={styles.label}>
          Industry
        </Text>
        <ChoiceChips
          options={INDUSTRIES}
          value={form.industry}
          onChange={(v) => setForm((f) => ({ ...f, industry: v }))}
        />
        {errors.industry ? (
          <Text variant="caption" tone="danger">
            {errors.industry}
          </Text>
        ) : null}
      </View>
      <TextField
        label="Street address"
        value={form.line1}
        onChangeText={set('line1')}
        error={errors.line1}
        textContentType="streetAddressLine1"
      />
      <TextField
        label="Suite or unit (optional)"
        value={form.line2}
        onChangeText={set('line2')}
        textContentType="streetAddressLine2"
      />
      <View style={styles.row}>
        <View style={{ flex: 2, minWidth: 0 }}>
          <TextField
            label="City"
            value={form.city}
            onChangeText={set('city')}
            error={errors.city}
            textContentType="addressCity"
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextField
            label="State"
            value={form.state}
            onChangeText={set('state')}
            error={errors.state}
            autoCapitalize="characters"
            maxLength={2}
            placeholder="OR"
          />
        </View>
        <View style={{ flex: 1.4, minWidth: 0 }}>
          <TextField
            label="ZIP"
            value={form.postalCode}
            onChangeText={set('postalCode')}
            error={errors.postalCode}
            keyboardType="number-pad"
            textContentType="postalCode"
          />
        </View>
      </View>
      <TextField
        label="Operating since"
        value={form.foundedOn}
        onChangeText={set('foundedOn')}
        error={errors.foundedOn}
        placeholder="YYYY-MM"
        keyboardType="numbers-and-punctuation"
        helper="The month you opened for business."
      />
      <TextField
        label="Monthly revenue"
        value={form.revenue}
        onChangeText={set('revenue')}
        error={errors.revenue}
        prefix="$"
        keyboardType="decimal-pad"
        placeholder="48,000"
        helper="A typical month of sales. We verify this against your bank account."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  label: { textTransform: 'uppercase', letterSpacing: 0.6 },
  row: { flexDirection: 'row', gap: spacing.sm },
});
