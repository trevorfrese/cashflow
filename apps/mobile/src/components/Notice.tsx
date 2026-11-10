import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { colors, radii, spacing } from '@/theme';

type Tone = 'info' | 'danger' | 'success' | 'warning';
const bg: Record<Tone, string> = {
  info: colors.infoBg,
  danger: colors.dangerBg,
  success: colors.successBg,
  warning: colors.warningBg,
};
const fg: Record<Tone, string> = {
  info: colors.primary,
  danger: colors.late,
  success: colors.paid,
  warning: colors.dueSoon,
};

export function Notice({
  tone = 'info',
  title,
  message,
}: {
  tone?: Tone;
  title?: string;
  message: string;
}) {
  return (
    <View style={[styles.box, { backgroundColor: bg[tone] }]} accessibilityRole="alert">
      {title ? (
        <Text variant="bodyStrong" style={{ color: fg[tone] }}>
          {title}
        </Text>
      ) : null}
      <Text variant="body" style={{ color: tone === 'info' ? colors.text : fg[tone] }}>
        {message}
      </Text>
    </View>
  );
}

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <View style={styles.empty}>
      <Text variant="heading">{title}</Text>
      <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radii.control, padding: spacing.md, gap: 4 },
  empty: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
});
