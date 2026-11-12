import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { spacing } from '@/theme';

/**
 * A short title with a tag (a Pill) after it. They sit on one line when both fit and wrap
 * onto two when they do not, so the title is never squeezed into a narrow column beside the
 * tag and never breaks mid-word.
 */
export function TitleRow({
  title,
  pill,
  variant = 'bodyStrong',
}: {
  title: string;
  pill: ReactNode;
  variant?: 'bodyStrong' | 'heading' | 'title';
}) {
  return (
    <View style={styles.row}>
      <Text variant={variant} style={styles.title}>
        {title}
      </Text>
      {pill}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing.sm,
    rowGap: spacing.xs,
  },
  title: { flexShrink: 1, minWidth: 140 },
});
