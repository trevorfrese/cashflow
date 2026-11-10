import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { border, colors, fonts, hardShadow, radii, spacing } from '@/theme';

/**
 * One of several options. `chips` are bordered pills for pick lists (industries, scenarios).
 * `tabs` are plain text with an ink underline under the selected one, for switching context.
 */
export function ChoiceChips<T extends string | number>({
  options,
  value,
  onChange,
  trailing,
  appearance = 'chips',
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  /** Extra chip at the end, for example an add button. */
  trailing?: ReactNode;
  appearance?: 'chips' | 'tabs';
}) {
  const tabs = appearance === 'tabs';
  return (
    <View style={[styles.row, tabs && styles.tabRow]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={
              tabs
                ? [styles.tab, selected && styles.tabSelected]
                : [styles.chip, selected && styles.selected]
            }
          >
            <Text
              style={[
                styles.chipText,
                !tabs && selected && { color: colors.gold },
                tabs && !selected && { color: colors.textMuted },
              ]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
      {trailing}
    </View>
  );
}

/** A chip that matches ChoiceChips, for actions beside them. */
export function ActionChip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.chip}>
      <Text style={[styles.chipText, { color: colors.azureDeep }]}>{label}</Text>
    </Pressable>
  );
}

/** Joined radio buttons for two to four short options. The selected one is gold. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <View style={[styles.segment, hardShadow('m')]} accessibilityRole="radiogroup">
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={[
              styles.segmentItem,
              i < options.length - 1 && styles.segmentDivider,
              selected && { backgroundColor: colors.gold },
            ]}
          >
            <Text style={[styles.segmentText, selected && { fontFamily: fonts.heading }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: border.width,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  selected: { backgroundColor: colors.ink },
  tabRow: { gap: spacing.md },
  tab: { paddingVertical: 6, borderBottomWidth: border.width, borderBottomColor: 'transparent' },
  tabSelected: { borderBottomColor: colors.ink },
  chipText: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.ink },
  segment: {
    flexDirection: 'row',
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.control,
    backgroundColor: colors.white,
    overflow: 'hidden',
  },
  segmentItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  segmentDivider: { borderRightWidth: border.width, borderRightColor: colors.ink },
  segmentText: { fontFamily: fonts.bold, fontSize: 15, lineHeight: 20, color: colors.ink },
});
