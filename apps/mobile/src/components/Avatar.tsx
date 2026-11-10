import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { border, colors, fonts, radii } from '@/theme';

/** Initials in a dusk circle with an ink ring. */
export function Avatar({ name, size = 40 }: { name?: string | null; size?: number }) {
  const initials =
    (name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || '?';
  return (
    <View style={[styles.circle, { width: size, height: size }]} accessibilityLabel={name ?? ''}>
      <Text style={[styles.text, { fontSize: Math.round(size * 0.35) }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.gold,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.pill,
  },
  text: { fontFamily: fonts.display, color: colors.ink },
});
