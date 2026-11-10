import { StyleSheet, View, type ViewProps } from 'react-native';

import { colors, radii, spacing } from '@/theme';

export function Card({
  style,
  tone = 'surface',
  ...rest
}: ViewProps & { tone?: 'surface' | 'gold' | 'ink' | 'alt' }) {
  return <View {...rest} style={[styles.card, styles[tone], style]} />;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  surface: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  alt: { backgroundColor: colors.surfaceAlt },
  gold: { backgroundColor: colors.brightGold },
  ink: { backgroundColor: colors.text },
});
