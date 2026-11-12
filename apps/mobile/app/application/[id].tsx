import type { ExplanationCheck, ExplanationFactor, PrincipalReason } from '@cashflow/shared';
import type { CashFlowSummary } from '@cashflow/shared';
import { formatBps, formatCents } from '@cashflow/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Notice, Pill, Screen, ScoreGauge, Text } from '@/components';
import { describeError } from '@/lib/api';
import { useBusiness } from '@/lib/business';
import { FACTOR_STATUS, longDate } from '@/lib/decision';
import { formatPeriod } from '@/lib/forms';
import { IN_REVIEW_COPY } from '@/lib/plan-notices';
import { leaseForPassThrough } from '@/lib/pass-through';
import {
  useApplication,
  useBankLinks,
  useDeclineOffer,
  useExplanation,
  useLeases,
  usePassThroughOffer,
  useResubmitApplication,
  useStartPassThroughPlan,
} from '@/lib/queries';
import { border, colors, radii, spacing } from '@/theme';

/**
 * The decision, explained. Everything is stacked for a phone: no long text sits beside a
 * pill, a gauge or a button. The score is shown only on an approval or a counter offer; a
 * decline shows its principal reasons and what would change them, then how each factor did,
 * then the free pass-through plan, then the notice.
 */
export default function Decision() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { business } = useBusiness();
  const { data: app, isLoading } = useApplication(id, business?.id);
  const explanation = useExplanation(id);
  const links = useBankLinks(business?.id);
  const resubmit = useResubmitApplication();
  const [error, setError] = useState<string | null>(null);

  const e = explanation.data;
  if (isLoading || explanation.isLoading || !app || !e) {
    return (
      <Screen back title="Decision">
        <Text tone="muted">
          {isLoading || explanation.isLoading ? 'Loading…' : 'Application not found.'}
        </Text>
      </Screen>
    );
  }
  const linked = links.data?.filter((l) => l.status === 'LINKED') ?? [];

  const retry = async () => {
    setError(null);
    try {
      await resubmit.mutateAsync({
        applicationId: app.id,
        bankLinkId: linked[linked.length - 1]?.id,
      });
      void explanation.refetch();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const footer = (() => {
    if (e.outcome === 'APPROVED' || e.outcome === 'COUNTER_OFFER') {
      return (
        <Button
          title="Link your lease"
          size="lg"
          icon="arrow-right"
          onPress={() => router.push('/lease/new')}
        />
      );
    }
    if (e.outcome === 'NEEDS_INFO') {
      return linked.length > 0 ? (
        <Button
          title="Run the decision again"
          onPress={() => void retry()}
          loading={resubmit.isPending}
        />
      ) : (
        <Button
          title="Connect a bank account"
          variant="azure"
          onPress={() => router.push('/bank/connect')}
        />
      );
    }
    return (
      <Button title="Back to home" variant="secondary" onPress={() => router.replace('/(tabs)')} />
    );
  })();

  const approved = e.outcome === 'APPROVED' || e.outcome === 'COUNTER_OFFER';
  const helping = e.factors.filter((f) => f.status === 'HELPING');

  return (
    <Screen back title={e.headline} footer={footer}>
      {error ? <Notice tone="danger" message={error} /> : null}

      {e.outcome === 'IN_REVIEW' ? (
        <>
          <Notice tone="info" title={IN_REVIEW_COPY.title} message={IN_REVIEW_COPY.message} />
          <Section title="What happens next">
            <Text variant="body">{e.nextSteps?.text ?? e.summary}</Text>
          </Section>
        </>
      ) : (
        <Card tone="paper" shadow="none">
          <Text variant="body">{e.summary}</Text>
        </Card>
      )}

      {approved && e.score ? (
        <Card>
          <View style={styles.gaugeBlock}>
            <ScoreGauge score={e.score.value} grade={e.score.grade} />
          </View>
          {e.terms ? (
            <View style={styles.stats}>
              <Stat
                label="Monthly rent limit"
                value={formatCents(e.terms.approvedMonthlyLimitCents, { showCents: false })}
              />
              {e.outcome === 'COUNTER_OFFER' ? (
                <Stat
                  label="You asked for"
                  value={formatCents(e.terms.requestedMonthlyRentCents, { showCents: false })}
                />
              ) : null}
              <Stat label="Fee per month" value={`${formatBps(e.terms.feeBps)} of rent`} />
              <Stat
                label="Suggested cadence"
                value={`${e.terms.installmentsPerMonth} installments a month`}
              />
              <Text variant="body" tone="muted">
                {e.terms.why}
              </Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      {e.outcome === 'COUNTER_OFFER' ? (
        <>
          <Section title="Why less than you asked">
            {e.principalReasons.map((r, i) => (
              <ReasonBlock key={r.code} reason={r} index={i + 1} />
            ))}
          </Section>
          {e.canDeclineOffer ? <DeclineOfferCard applicationId={app.id} /> : null}
        </>
      ) : null}

      {e.outcome === 'DECLINED' ? (
        <Section title="Why we could not approve this">
          {e.principalReasons.map((r, i) => (
            <ReasonBlock key={r.code} reason={r} index={i + 1} />
          ))}
        </Section>
      ) : null}

      {e.outcome === 'NEEDS_INFO' ? (
        <Section title="What we need">
          {e.requestedInformation.map((r, i) => (
            <ReasonBlock key={r.code} reason={r} index={i + 1} guidanceLabel="How to provide it" />
          ))}
          {e.nextSteps?.expectedBy ? (
            <View style={styles.dateBlock}>
              <Text variant="label">Please provide it by</Text>
              <Text variant="heading">{longDate(e.nextSteps.expectedBy)}</Text>
            </View>
          ) : null}
        </Section>
      ) : null}

      {approved && helping.length > 0 ? (
        <Section title="What helped">
          {helping.map((f) => (
            <FactorRow key={f.code} factor={f} />
          ))}
        </Section>
      ) : null}

      {e.outcome === 'DECLINED' || e.outcome === 'COUNTER_OFFER' ? (
        <Section title="How each part of your cash flow did">
          {e.factors.map((f) => (
            <FactorRow key={f.code} factor={f} />
          ))}
        </Section>
      ) : null}

      {e.outcome === 'DECLINED' && business ? (
        <PassThroughCard applicationId={app.id} businessId={business.id} />
      ) : null}

      {e.notices.length > 0 ? (
        <Section title={e.notices.length === 1 ? 'Your notice' : 'Your notices'}>
          {e.notices.map((n) => (
            <View key={n.id} style={styles.noticeRow}>
              <Text variant="bodyStrong">{n.title}</Text>
              <Text variant="caption" tone="muted">
                {`Sent ${longDate(n.deliveredAt)} in the app`}
              </Text>
              <Button
                title="Read the notice"
                variant="secondary"
                size="sm"
                icon="arrow-right"
                onPress={() =>
                  router.push({
                    pathname: '/notice/[id]',
                    params: { id: n.id, applicationId: app.id },
                  })
                }
              />
            </View>
          ))}
        </Section>
      ) : null}

      {e.checks.length > 0 && e.outcome !== 'IN_REVIEW' ? (
        <Section title="Checks we ran">
          {e.checks.map((c) => (
            <CheckRow key={c.code} check={c} />
          ))}
        </Section>
      ) : null}

      {e.dataSources.length > 0 ? (
        <Section title="What we used">
          {e.dataSources.map((d) => (
            <View key={`${d.kind}-${d.name}`} style={styles.source}>
              <Text variant="bodyStrong">{d.name}</Text>
              <Text variant="caption" tone="muted">
                {d.dataAsOf ? `Data as of ${longDate(d.dataAsOf)}` : 'Connected'}
              </Text>
            </View>
          ))}
        </Section>
      ) : null}

      {app.decision?.cashFlow && e.outcome !== 'IN_REVIEW' ? (
        <CashFlowCard summary={app.decision.cashFlow} />
      ) : null}
    </Screen>
  );
}

/** One principal reason: what happened, then what would change it. Always stacked. */
function ReasonBlock({
  reason,
  index,
  guidanceLabel = 'What would change this',
}: {
  reason: PrincipalReason;
  index: number;
  guidanceLabel?: string;
}) {
  return (
    <View style={styles.reason}>
      <Text variant="bodyStrong">{`${index}. ${reason.title}`}</Text>
      <Text variant="body">{reason.text}</Text>
      <View style={styles.guidance}>
        <Text variant="label">{guidanceLabel}</Text>
        <Text variant="body" tone="muted">
          {reason.guidance}
        </Text>
      </View>
    </View>
  );
}

/** A factor: its short label and status wrap together; the detail gets the full width below. */
function FactorRow({ factor }: { factor: ExplanationFactor }) {
  const s = FACTOR_STATUS[factor.status];
  return (
    <View style={styles.factor}>
      <View style={styles.labelRow}>
        <Text variant="bodyStrong" style={styles.labelText}>
          {factor.label}
        </Text>
        <Pill label={s.label} tone={s.tone} />
      </View>
      <Text variant="body" tone="muted">
        {factor.detail}
      </Text>
    </View>
  );
}

function CheckRow({ check }: { check: ExplanationCheck }) {
  return (
    <View style={styles.factor}>
      <View style={styles.labelRow}>
        <Text variant="bodyStrong" style={styles.labelText}>
          {check.label}
        </Text>
        <Pill label={check.passed ? 'Met' : 'Not met'} tone={check.passed ? 'paid' : 'late'} />
      </View>
      {check.passed ? null : (
        <Text variant="body" tone="muted">
          {check.detail}
        </Text>
      )}
    </View>
  );
}

/** Turn down a counter offer. The notice is stored and shown at once. */
function DeclineOfferCard({ applicationId }: { applicationId: string }) {
  const decline = useDeclineOffer();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDecline = async () => {
    setError(null);
    try {
      const notice = await decline.mutateAsync(applicationId);
      router.push({ pathname: '/notice/[id]', params: { id: notice.id, applicationId } });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card tone="paper" shadow="none">
      <Text variant="heading">Not what you need?</Text>
      <Text variant="body" tone="muted">
        You can decline this offer. We will send you a notice with the reasons we could not approve
        the full rent. You can apply again at any time.
      </Text>
      {error ? <Notice tone="danger" message={error} /> : null}
      {confirming ? (
        <View style={styles.buttons}>
          <Button
            title="Yes, decline the offer"
            variant="danger"
            onPress={() => void onDecline()}
            loading={decline.isPending}
          />
          <Button title="Keep the offer" variant="text" onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <Button
          title="Decline this offer"
          variant="secondary"
          onPress={() => setConfirming(true)}
        />
      )}
    </Card>
  );
}

/**
 * The free pass-through plan, offered on a declined application: CashFlow collects the rent
 * a few days early and pays the landlord on the due date. Starting it needs a linked lease.
 */
function PassThroughCard({
  applicationId,
  businessId,
}: {
  applicationId: string;
  businessId: string;
}) {
  const offer = usePassThroughOffer(applicationId);
  const leases = useLeases(businessId);
  const start = useStartPassThroughPlan();
  const [error, setError] = useState<string | null>(null);
  const o = offer.data;
  if (!o || !o.eligible) return null;
  const lease = leaseForPassThrough(leases.data);

  const onStart = async () => {
    setError(null);
    if (!lease) {
      router.push({ pathname: '/lease/new', params: { passThroughFor: applicationId } });
      return;
    }
    try {
      await start.mutateAsync({ applicationId, leaseId: lease.id });
      router.replace('/(tabs)');
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <Card shadowColor={colors.azure}>
      <Pill label="Free plan" tone="info" />
      <Text variant="heading">{o.headline}</Text>
      <Text variant="body">{o.explanation}</Text>
      <View style={{ gap: spacing.xs }}>
        <Text variant="body" tone="muted">
          {`Rent: ${formatCents(o.monthlyRentCents)} a month, collected from your bank ${o.collectionLeadBusinessDays} business days before it is due.`}
        </Text>
        <Text variant="body" tone="muted">
          {`Fee: ${formatCents(o.feeCents)}. No late fees.`}
        </Text>
      </View>
      {error ? <Notice tone="danger" message={error} /> : null}
      {o.existingPlanId ? (
        <>
          <Notice tone="success" message="Your free pass-through plan is running." />
          <Button
            title="See it on home"
            variant="secondary"
            onPress={() => router.replace('/(tabs)')}
          />
        </>
      ) : (
        <>
          {lease ? (
            <Text variant="caption" tone="muted">
              {`For your lease with ${lease.landlordName}.`}
            </Text>
          ) : null}
          <Button
            title={lease ? 'Start the free plan' : 'Link your lease to start'}
            variant="azure"
            icon="arrow-right"
            onPress={() => void onStart()}
            loading={start.isPending}
            disabled={leases.isLoading}
          />
        </>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <Text variant="heading">{title}</Text>
      <View style={{ gap: spacing.md, paddingTop: spacing.xs }}>{children}</View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="heading">{value}</Text>
    </View>
  );
}

function CashFlowCard({ summary: s }: { summary: CashFlowSummary }) {
  const max = Math.max(1, ...s.monthly.map((m) => m.revenueCents));
  return (
    <Card>
      <Text variant="heading">Your cash flow, from the bank</Text>
      <View style={styles.grid}>
        <Metric
          label="Verified revenue"
          value={`${formatCents(s.verifiedMonthlyRevenueCents, { showCents: false })}/mo`}
        />
        <Metric
          label="Free cash flow"
          value={`${formatCents(s.monthlyNetCashFlowCents, { showCents: false })}/mo`}
        />
        <Metric
          label="Cash on hand"
          value={s.daysOfCashOnHand === null ? 'Unknown' : `${s.daysOfCashOnHand} days`}
        />
        <Metric label="Overdrafts (90d)" value={String(s.nsfCount90)} />
      </View>
      {s.monthly.length > 0 ? (
        <View style={{ gap: 6, paddingTop: spacing.sm }}>
          <Text variant="label">Monthly revenue</Text>
          <View style={styles.bars}>
            {s.monthly.map((m) => (
              <View key={m.month} style={styles.barCol}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: Math.max(8, Math.round((m.revenueCents / max) * 72)),
                      backgroundColor: m.nsfCount > 0 ? colors.jetRed : colors.gold,
                    },
                  ]}
                />
              </View>
            ))}
          </View>
          <View style={styles.barLabels}>
            <Text variant="caption" tone="muted">
              {formatPeriod(s.monthly[0]!.month)}
            </Text>
            <Text variant="caption" tone="muted">
              {formatPeriod(s.monthly[s.monthly.length - 1]!.month)}
            </Text>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  gaugeBlock: { alignItems: 'center', paddingVertical: spacing.sm },
  stats: { gap: spacing.smd, paddingTop: spacing.sm },
  dateBlock: { gap: 2 },
  reason: { gap: spacing.xs },
  guidance: {
    gap: 2,
    backgroundColor: colors.paper,
    borderRadius: radii.chip,
    padding: spacing.smd,
  },
  factor: { gap: spacing.xs },
  // A short label and its pill wrap onto two lines rather than squeeze the label.
  labelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  labelText: { flexShrink: 1, minWidth: 140 },
  noticeRow: { gap: spacing.xs, alignItems: 'flex-start' },
  source: { gap: 2 },
  buttons: { gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.sm },
  metric: {
    width: '47%',
    backgroundColor: colors.paper,
    borderWidth: border.thin,
    borderColor: colors.ink,
    borderRadius: radii.chip,
    padding: 10,
    gap: 2,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 76 },
  barCol: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderRadius: 3, borderWidth: border.thin, borderColor: colors.ink },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between' },
});
