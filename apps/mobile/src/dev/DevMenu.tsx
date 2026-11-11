import type {
  DevAdvanceRequest,
  DevAdvanceResult,
  DevOverview,
  DevPersona,
} from '@cashflow/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { IconButton } from '@/components/IconButton';
import { ListRow } from '@/components/ListRow';
import { Notice } from '@/components/Notice';
import { Pill } from '@/components/Pill';
import { Text } from '@/components/Text';
import { API_URL, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/forms';
import { border, colors, spacing } from '@/theme';

import { devApi } from './api';
import { useDevTools } from './DevTools';
import { DEV_HOME_URL, DEV_MENU_SHORTCUT, OPS_URL } from './flag';
import { groupPersonas } from './grouping';

/**
 * The dev menu: a full screen modal over the whole window (outside the phone frame on
 * web). Pick a persona to sign in as, move the simulated clock, rebuild data. Built from
 * the app's own components so it reads as part of the product, clearly labelled DEV MODE.
 */
export function DevMenu() {
  const dev = useDevTools()!;
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 860;
  const [personas, setPersonas] = useState<DevPersona[] | null>(null);
  const [overview, setOverview] = useState<DevOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<DevAdvanceResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, view] = await Promise.all([devApi.personas(), devApi.overview()]);
      setPersonas(list.personas);
      setOverview(view);
      setError(null);
    } catch (e) {
      setError(
        `${describeError(e)}. The dev menu needs the API at ${API_URL} running with ENABLE_DEV_TOOLS=true.`,
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one dev action with the menu locked, and shows its error plainly if it fails. */
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    setConfirmReset(false);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const signInAs = (persona: DevPersona, reset = false) =>
    run(reset ? `Rebuilding ${persona.title}` : `Signing in as ${persona.title}`, async () => {
      await dev.switchTo(persona.key, { reset });
      dev.closeMenu();
    });

  const advance = (body: DevAdvanceRequest, label: string) =>
    run(label, async () => {
      const result = await devApi.advance(body);
      setAdvanced(result);
      await dev.refresh(result.clock);
      await load();
    });

  const resetEverything = () =>
    run('Rebuilding the demo data', async () => {
      const result = await devApi.resetEverything();
      setAdvanced(null);
      // Every account was recreated, so the session this app holds is gone with the rest.
      if (dev.persona) await dev.switchTo(dev.persona.key);
      else if (user) await dev.leave();
      await dev.refresh(result.clock);
      await load();
      setNotice(
        `Rebuilt ${result.personas.length} personas in ${result.seconds.toFixed(1)}s. The date is ${formatDate(result.clock.today)} again.`,
      );
    });

  const clock = overview?.clock ?? dev.clock;
  const active = personas?.find((p) => p.key === dev.persona?.key) ?? dev.persona;
  const groups = personas ? groupPersonas(personas) : [];

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={dev.closeMenu}
      statusBarTranslucent
    >
      <SafeAreaProvider>
        <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
          <View style={styles.header}>
            <View style={styles.headerInner}>
              <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                <Text variant="display" tone="gold">
                  DEV MODE
                </Text>
                <View style={styles.tags}>
                  <Pill
                    tone={clock && clock.aheadDays > 0 ? 'gold' : 'neutral'}
                    label={
                      clock
                        ? clock.aheadDays > 0
                          ? `Simulated ${formatDate(clock.today)} · +${clock.aheadDays}d`
                          : `Today ${formatDate(clock.today)}`
                        : 'Date unknown'
                    }
                  />
                  <Pill tone="info" label={`API ${API_URL.replace(/^https?:\/\//, '')}`} />
                  <Pill
                    tone="paid"
                    label={overview ? `${overview.environment.nodeEnv} · sandbox` : 'sandbox'}
                  />
                </View>
              </View>
              <IconButton
                icon="close"
                label="Close the dev menu"
                tone="gold"
                onPress={dev.closeMenu}
              />
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {busy ? (
              <View style={styles.busy} accessibilityRole="alert">
                <ActivityIndicator color={colors.ink} />
                <Text variant="bodyStrong">{busy}…</Text>
              </View>
            ) : null}
            {error ? <Notice tone="danger" title="Dev tools error" message={error} /> : null}
            {notice ? <Notice tone="success" message={notice} /> : null}

            <View style={[styles.columns, wide && styles.columnsWide]}>
              <Card style={styles.column}>
                <Text variant="label">You are</Text>
                {active ? (
                  <>
                    <View style={styles.rowBetween}>
                      <Text variant="heading" style={{ flex: 1 }}>
                        {active.title}
                      </Text>
                      <Pill label={active.state.label} tone={active.state.tone} />
                    </View>
                    <Text variant="caption" tone="muted">
                      {active.email}
                    </Text>
                    <Text variant="body">{active.demonstrates}</Text>
                    <Text variant="caption" tone="muted">
                      Worth visiting: {active.screens.join(', ')}.
                    </Text>
                    {active.walkthrough ? (
                      <Notice
                        tone="info"
                        title="Preset inputs"
                        message={active.walkthrough.summary}
                      />
                    ) : null}
                  </>
                ) : (
                  <Text variant="body">
                    {user
                      ? `${user.email}, signed in the ordinary way. Pick a persona below to switch.`
                      : 'Nobody. Pick a persona below to sign in as it.'}
                  </Text>
                )}
                <View style={styles.actions}>
                  {active ? (
                    <Button
                      title="Reset this persona"
                      variant="secondary"
                      size="sm"
                      disabled={Boolean(busy) || !active.resettable}
                      onPress={() => void signInAs(active, true)}
                    />
                  ) : null}
                  {user ? (
                    <Button
                      title="Sign out to welcome"
                      variant="secondary"
                      size="sm"
                      disabled={Boolean(busy)}
                      onPress={() =>
                        void run('Signing out', async () => {
                          await dev.leave();
                          dev.closeMenu();
                        })
                      }
                    />
                  ) : null}
                </View>
                {active && !active.resettable ? (
                  <Text variant="caption" tone="muted">
                    This persona is months of replayed ledger history, and the ledger is
                    append-only, so it is rebuilt by Reset everything, not on its own.
                  </Text>
                ) : null}
              </Card>

              <Card tone="gold" style={styles.column}>
                <Text variant="label">Simulated clock</Text>
                <Text variant="number">{clock ? formatDate(clock.today) : '…'}</Text>
                <Text variant="caption">
                  {clock && clock.aheadDays > 0
                    ? `${clock.aheadDays} ${clock.aheadDays === 1 ? 'day' : 'days'} ahead of the real date. Moving on runs every job for each day crossed, for every business.`
                    : 'The real date. Moving on runs every job for each day crossed, for every business.'}
                </Text>
                <View style={styles.actions}>
                  <Button
                    title="+1 day"
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(busy)}
                    onPress={() => void advance({ days: 1 }, 'Advancing one day')}
                  />
                  <Button
                    title="+1 week"
                    variant="secondary"
                    size="sm"
                    disabled={Boolean(busy)}
                    onPress={() => void advance({ days: 7 }, 'Advancing one week')}
                  />
                  <Button
                    title="To next event"
                    variant="night"
                    size="sm"
                    disabled={Boolean(busy) || !active?.nextEvent}
                    onPress={() =>
                      active
                        ? void advance(
                            { toNextEventFor: active.key },
                            `Advancing to the next event for ${active.title}`,
                          )
                        : undefined
                    }
                  />
                </View>
                <Text variant="caption">
                  {active?.nextEvent
                    ? `Next for ${active.title}: ${active.nextEvent.label}, ${formatDate(active.nextEvent.date)}.`
                    : active
                      ? `Nothing is scheduled for ${active.title}.`
                      : 'Sign in as a persona to jump to its next event.'}
                </Text>
                {advanced ? (
                  <View style={styles.result}>
                    <Text variant="bodyStrong">
                      {formatDate(advanced.from)} to {formatDate(advanced.to)}
                      {advanced.event ? `: ${advanced.event.label}` : ''}
                    </Text>
                    {advanced.changes.map((line) => (
                      <Text key={line} variant="caption">
                        {`• ${line}`}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </Card>
            </View>

            {groups.map((group) => (
              <View key={group.group} style={styles.group}>
                <Text variant="title">{group.title}</Text>
                <View style={[styles.columns, wide && styles.columnsWide]}>
                  {group.sections.map((section) => (
                    <Card key={section.title} style={styles.column}>
                      <Text variant="label">{section.title}</Text>
                      {section.personas.map((p, i) => (
                        <ListRow
                          key={p.key}
                          title={p.title}
                          subtitle={p.demonstrates}
                          onPress={busy ? undefined : () => void signInAs(p)}
                          right={
                            <>
                              <Pill label={p.state.label} tone={p.state.tone} />
                              {p.key === dev.persona?.key ? <Pill label="You" tone="gold" /> : null}
                            </>
                          }
                          last={i === section.personas.length - 1}
                        />
                      ))}
                    </Card>
                  ))}
                </View>
              </View>
            ))}
            {!personas && !error ? <Text tone="muted">Loading personas…</Text> : null}

            <Card>
              <Text variant="label">Tools</Text>
              <View style={styles.actions}>
                <Button
                  title="Ops console"
                  variant="secondary"
                  size="sm"
                  onPress={() => void Linking.openURL(OPS_URL)}
                />
                <Button
                  title="Dev home"
                  variant="secondary"
                  size="sm"
                  onPress={() => void Linking.openURL(DEV_HOME_URL)}
                />
                <Button
                  title={confirmReset ? 'Yes, wipe and rebuild' : 'Reset everything'}
                  variant="danger"
                  size="sm"
                  disabled={Boolean(busy)}
                  onPress={() => (confirmReset ? void resetEverything() : setConfirmReset(true))}
                />
                {confirmReset ? (
                  <Button
                    title="Cancel"
                    variant="text"
                    size="sm"
                    onPress={() => setConfirmReset(false)}
                  />
                ) : null}
              </View>
              <Text variant="caption" tone="muted">
                {confirmReset
                  ? 'This wipes the database and rebuilds every persona as of the real date. Anything you created is lost. It takes a few seconds.'
                  : 'Reset everything wipes the database, rebuilds every persona, and puts the clock back on the real date.'}
              </Text>
            </Card>

            <Text variant="caption" tone="muted" style={styles.footnote}>
              Open this menu with five quick taps on the coin (the CashFlow wordmark on the welcome
              screen){Platform.OS === 'web' ? `, or ${DEV_MENU_SHORTCUT}` : ''}. It exists only when
              EXPO_PUBLIC_DEV_TOOLS=true. Sandbox data only: no real money moves.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    backgroundColor: colors.night,
    borderBottomWidth: border.width,
    borderBottomColor: colors.ink,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  headerInner: {
    width: '100%',
    maxWidth: 980,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  content: {
    width: '100%',
    maxWidth: 980 + spacing.md * 2,
    alignSelf: 'center',
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  busy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: 10,
    backgroundColor: colors.warningBg,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  columns: { gap: spacing.md },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  column: { flex: 1, minWidth: 0 },
  group: { gap: spacing.smd, marginTop: spacing.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  result: {
    gap: 2,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: border.thin,
    borderTopColor: colors.ink,
  },
  footnote: { textAlign: 'center' },
});
