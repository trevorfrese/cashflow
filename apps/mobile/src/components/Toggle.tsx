import { Pressable, StyleSheet, View } from 'react-native';

import { border, colors, radii } from '@/theme';

/** Switch from the design system: a bordered pill that goes mint when on. */
export function Toggle({
  value,
  onValueChange,
  label,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={[
        styles.track,
        { backgroundColor: value ? colors.mint : colors.sand },
        { alignItems: value ? 'flex-end' : 'flex-start' },
      ]}
    >
      <View style={styles.knob} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 60,
    height: 34,
    paddingHorizontal: 3,
    justifyContent: 'center',
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.pill,
  },
  knob: {
    width: 22,
    height: 22,
    backgroundColor: colors.white,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.pill,
  },
});
