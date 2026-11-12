import { CreateLeaseRequest, formatCents, type Lease } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Notice, Screen, Segmented, Text, TextField, Toggle } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { centsToDollarsInput, dollarsToCents, normalizeMonthInput, todayIso } from '@/lib/forms';
import {
  useApplications,
  useCreateLease,
  usePassThroughOffer,
  useStartPassThroughPlan,
} from '@/lib/queries';
import { colors, fonts, spacing } from '@/theme';

const DUE_DAYS = [1, 5, 10, 15] as const;

export default function NewLease() {
  // Set when linking a lease to start the free pass-through plan on a declined application.
  const { passThroughFor } = useLocalSearchParams<{ passThroughFor?: string }>();
  const passThrough = Boolean(passThroughFor);
  const { business } = useBusiness();
  const applications = useApplications(business?.id);
  const approved = passThrough
    ? undefined
    : applications.data?.find((a) => a.status === 'APPROVED');
  const offer = usePassThroughOffer(passThroughFor, passThrough);
  const create = useCreateLease();
  const startPassThrough = useStartPassThroughPlan();
  // Kept so a failed plan start can be retried without linking the lease twice.
  const [created, setCreated] = useState<Lease | null>(null);
  const [sameAddress, setSameAddress] = useState(true);
  const [form, setForm] = useState({
    landlordName: '',
    landlordEmail: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
    rent: '',
    dueDay: 1 as number,
    startsOn: nextMonthStart(),
    accountHolderName: '',
    routingNumber: '',
    accountNumber: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const suggestedRentCents =
    approved?.requestedMonthlyRentCents ?? offer.data?.monthlyRentCents ?? null;
  useEffect(() => {
    if (suggestedRentCents !== null)
      setForm((f) => ({ ...f, rent: f.rent || centsToDollarsInput(suggestedRentCents) }));
  }, [suggestedRentCents]);

  const limit = approved?.decision?.approvedMonthlyLimitCents ?? null;
  const rentCents = dollarsToCents(form.rent);
  const overLimit = limit !== null && rentCents !== null && rentCents > limit;

  const submit = async () => {
    if (!business) return;
    const startsOn = normalizeMonthInput(form.startsOn);
    const address = sameAddress
      ? business.address
      : {
          line1: form.line1.trim(),
          line2: form.line2.trim() || undefined,
          city: form.city.trim(),
          state: form.state.trim().toUpperCase(),
          postalCode: form.postalCode.trim(),
        };
    const next: Record<string, string> = {};
    if (rentCents === null || rentCents === 0) next.rent = 'Enter the monthly rent.';
    if (overLimit)
      next.rent = `Your approved limit is ${formatCents(limit!, { showCents: false })}.`;
    if (!startsOn) next.startsOn = 'Use the format YYYY-MM-DD.';
    if (!/^\d{9}$/.test(form.routingNumber)) next.routingNumber = 'Routing numbers are 9 digits.';
    if (!/^\d{4,17}$/.test(form.accountNumber)) next.accountNumber = 'Enter the account number.';
    const parsed = CreateLeaseRequest.safeParse({
      businessId: business.id,
      landlordName: form.landlordName.trim(),
      landlordEmail: form.landlordEmail.trim(),
      propertyAddress: address,
      monthlyRentCents: rentCents,
      dueDayOfMonth: form.dueDay,
      startsOn,
      landlordPayout: {
        accountHolderName: form.accountHolderName.trim(),
        routingNumber: form.routingNumber,
        accountNumberLast4: form.accountNumber.slice(-4),
        // The full account number never leaves the device in this sandbox. A production app
        // would tokenize it with the payments provider and send only the token.
        providerToken: `mock_landlord_${form.routingNumber}_${form.accountNumber.slice(-4)}`,
      },
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[issue.path.length - 1]);
        if (!next[key]) next[key] = issue.message;
      }
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      if (passThroughFor) {
        const lease = created ?? (await create.mutateAsync(parsed.data!));
        setCreated(lease);
        await startPassThrough.mutateAsync({ applicationId: passThroughFor, leaseId: lease.id });
        router.replace('/(tabs)');
        return;
      }
      const lease = await create.mutateAsync(parsed.data!);
      router.replace({ pathname: '/plan/new', params: { leaseId: lease.id } });
    } catch (e) {
      setErrors({ form: describeError(e) });
    }
  };

  return (
    <Screen
      back
      step={passThrough ? undefined : 'Step 3 of 4'}
      title="Link your lease"
      subtitle="Who gets paid, how much, and when."
      footer={
        <Button
          title={passThrough ? 'Start the free plan' : 'Continue to rent plan'}
          size="lg"
          icon="arrow-right"
          onPress={() => void submit()}
          loading={create.isPending || startPassThrough.isPending}
          disabled={!business}
        />
      }
    >
      {errors.form ? <Notice tone="danger" message={errors.form} /> : null}
      {created ? (
        <Notice
          tone="info"
          message={`Your lease with ${created.landlordName} is linked. Tap the button to try starting the plan again.`}
        />
      ) : null}
      {passThrough ? (
        <Notice
          tone="info"
          message="Free pass-through plan: we collect your rent a few days before it is due and pay your landlord on the due date. No fee."
        />
      ) : !approved ? (
        <Notice tone="warning" message="You need an approved application before linking a lease." />
      ) : null}

      <Text variant="label">Landlord</Text>
      <TextField
        label="Landlord or property manager"
        value={form.landlordName}
        onChangeText={set('landlordName')}
        error={errors.landlordName}
        placeholder="Harbor View Properties"
      />
      <TextField
        label="Landlord email"
        value={form.landlordEmail}
        onChangeText={set('landlordEmail')}
        error={errors.landlordEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        helper="We send a payment confirmation here each month."
      />

      <Text variant="label">Property</Text>
      <Card tone="paper" shadow="none" style={styles.switchRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="bodyStrong">Same as business address</Text>
          {business ? (
            <Text variant="caption" tone="muted">
              {business.address.line1}, {business.address.city}
            </Text>
          ) : null}
        </View>
        <Toggle
          value={sameAddress}
          onValueChange={setSameAddress}
          label="Same as business address"
        />
      </Card>
      {!sameAddress ? (
        <>
          <TextField
            label="Street address"
            value={form.line1}
            onChangeText={set('line1')}
            error={errors.line1}
          />
          <TextField
            label="Suite or unit (optional)"
            value={form.line2}
            onChangeText={set('line2')}
          />
          <View style={styles.row}>
            <View style={{ flex: 2, minWidth: 0 }}>
              <TextField
                label="City"
                value={form.city}
                onChangeText={set('city')}
                error={errors.city}
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
              />
            </View>
            <View style={{ flex: 1.4, minWidth: 0 }}>
              <TextField
                label="ZIP"
                value={form.postalCode}
                onChangeText={set('postalCode')}
                error={errors.postalCode}
                keyboardType="number-pad"
              />
            </View>
          </View>
        </>
      ) : null}

      <Text variant="label">Rent</Text>
      <TextField
        label="Monthly rent"
        value={form.rent}
        onChangeText={set('rent')}
        prefix="$"
        keyboardType="decimal-pad"
        error={errors.rent}
        helper={
          limit !== null
            ? `Approved for up to ${formatCents(limit, { showCents: false })} a month.`
            : undefined
        }
      />
      <View style={styles.group}>
        <Text style={styles.label}>Due on the</Text>
        <Segmented
          options={DUE_DAYS.map((d) => ({ value: d, label: ordinalLabel(d) }))}
          value={DUE_DAYS.includes(form.dueDay as (typeof DUE_DAYS)[number]) ? form.dueDay : null}
          onChange={(v) => setForm((f) => ({ ...f, dueDay: v }))}
        />
        <TextField
          label="Or another day of the month"
          value={String(form.dueDay)}
          onChangeText={(v) =>
            setForm((f) => ({ ...f, dueDay: Number(v.replace(/\D/g, '')) || 1 }))
          }
          keyboardType="number-pad"
          error={errors.dueDayOfMonth}
        />
      </View>
      <TextField
        label="First month CashFlow pays"
        value={form.startsOn}
        onChangeText={set('startsOn')}
        error={errors.startsOn}
        placeholder="YYYY-MM-DD"
      />

      <Text variant="label">Where the landlord gets paid</Text>
      <TextField
        label="Account holder name"
        value={form.accountHolderName}
        onChangeText={set('accountHolderName')}
        error={errors.accountHolderName}
      />
      <TextField
        label="Routing number"
        value={form.routingNumber}
        onChangeText={(v) => setForm((f) => ({ ...f, routingNumber: v.replace(/\D/g, '') }))}
        keyboardType="number-pad"
        maxLength={9}
        error={errors.routingNumber}
        placeholder="123456789"
      />
      <TextField
        label="Account number"
        value={form.accountNumber}
        onChangeText={(v) => setForm((f) => ({ ...f, accountNumber: v.replace(/\D/g, '') }))}
        keyboardType="number-pad"
        error={errors.accountNumber}
      />
    </Screen>
  );
}

function nextMonthStart(): string {
  const [y, m] = todayIso().split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

function ordinalLabel(d: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = d % 100;
  return `${d}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm },
  group: { gap: spacing.sm },
  label: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.ink },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
