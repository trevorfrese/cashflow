import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { border, colors, spacing } from '@/theme';

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  last = false,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const content = (
    <View style={[styles.row, !last && styles.divider]}>
      <View style={styles.left}>
        <Text variant="bodyStrong">{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: 12,
  },
  divider: { borderBottomWidth: border.thin, borderBottomColor: colors.ink },
  // The text takes the room; the right side (a pill, an amount, a chevron) stays short and
  // never squeezes the text into a narrow column.
  left: { flex: 1, minWidth: 0, gap: 2 },
  right: { flexShrink: 0, maxWidth: '45%', alignItems: 'flex-end', gap: 4 },
});
