import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { border, colors, fonts, hardShadow, radii, spacing } from '@/theme';

type Tone = 'info' | 'danger' | 'success' | 'warning';
const bg: Record<Tone, string> = {
  info: colors.infoBg,
  danger: colors.dangerBg,
  success: colors.successBg,
  warning: colors.warningBg,
};
const glyph: Record<Tone, string> = { info: 'i', danger: '×', success: '✓', warning: '!' };

/** Alert box: tinted fill, 3px ink border, a bold glyph, and a red shadow when it is an error. */
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
    <View
      style={[
        styles.box,
        { backgroundColor: bg[tone] },
        tone === 'danger' && hardShadow('m', colors.jetRed),
      ]}
      accessibilityRole="alert"
    >
      <Text style={styles.glyph}>{glyph[tone]}</Text>
      <View style={styles.body}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.message}>{message}</Text>
      </View>
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
  box: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.control,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  glyph: { fontFamily: fonts.display, fontSize: 16, lineHeight: 20, color: colors.ink, width: 14 },
  body: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 20, color: colors.ink },
  message: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
  empty: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
});
