import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Card, Notice, Pill, Screen, Text } from '@/components';
import { describeError } from '@/lib/api';
import { longDate, NOTICE_KIND_LABEL } from '@/lib/decision';
import { useNotices } from '@/lib/queries';
import { border, colors, radii, spacing } from '@/theme';

/**
 * "Your notice": the stored text of an adverse action notice or a notice of incompleteness,
 * exactly as it was delivered. The reasons are shown above it in the app's own type for
 * reading on a phone; the text below is the record.
 */
export default function NoticeScreen() {
  const { id, applicationId } = useLocalSearchParams<{ id: string; applicationId: string }>();
  const notices = useNotices(applicationId);
  const notice = notices.data?.find((n) => n.id === id);

  if (notices.isLoading || !notice) {
    return (
      <Screen back title="Your notice">
        {notices.error ? (
          <Notice tone="danger" message={describeError(notices.error)} />
        ) : (
          <Text tone="muted">{notices.isLoading ? 'Loading…' : 'Notice not found.'}</Text>
        )}
      </Screen>
    );
  }

  return (
    <Screen back title="Your notice" subtitle={NOTICE_KIND_LABEL[notice.kind]}>
      <Card tone="paper" shadow="none">
        <View style={styles.meta}>
          <Pill
            label={notice.isAdverseAction ? 'Notice of action' : 'Information needed'}
            tone={notice.isAdverseAction ? 'late' : 'due'}
          />
          <Text variant="body">{`Sent ${longDate(notice.deliveredAt)} in the app.`}</Text>
          <Text variant="body" tone="muted">{`Reference number ${notice.reference}`}</Text>
          {notice.respondBy ? (
            <Text variant="bodyStrong">{`Please respond by ${longDate(notice.respondBy)}.`}</Text>
          ) : null}
        </View>
      </Card>

      {notice.principalReasons.length > 0 ? (
        <Card>
          <Text variant="heading">
            {notice.isAdverseAction ? 'The principal reasons' : 'What we need'}
          </Text>
          <View style={styles.list}>
            {notice.principalReasons.map((r, i) => (
              <View key={r.code} style={styles.reason}>
                <Text variant="bodyStrong">{`${i + 1}. ${r.title}`}</Text>
                <Text variant="body">{r.text}</Text>
                <Text variant="body" tone="muted">
                  {r.guidance}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      <Card>
        <Text variant="heading">The notice</Text>
        <View style={styles.letter}>
          <Text variant="body" selectable style={styles.letterText}>
            {notice.text}
          </Text>
        </View>
      </Card>

      <Notice
        tone="info"
        message="Keep this for your records. It stays in the app, and you can ask support for a copy."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: { gap: spacing.sm, alignItems: 'flex-start' },
  list: { gap: spacing.md, paddingTop: spacing.xs },
  reason: { gap: spacing.xs },
  letter: {
    marginTop: spacing.sm,
    borderWidth: border.thin,
    borderColor: colors.ink,
    borderRadius: radii.chip,
    backgroundColor: colors.paper,
    padding: spacing.md,
  },
  letterText: { fontSize: 14, lineHeight: 20 },
});
