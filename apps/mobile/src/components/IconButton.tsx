import { Pressable, StyleSheet } from 'react-native';

import { Icon, type IconName } from './Icon';
import { border, colors, hardShadow, radii, sunk } from '@/theme';

const TONES = {
  surface: colors.white,
  gold: colors.gold,
  dusk: colors.dusk,
  sky: colors.sky,
} as const;

/** Square (or round) icon-only button. `label` is read by screen readers. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'surface',
  size = 44,
  round = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: keyof typeof TONES;
  size?: number;
  round?: boolean;
}) {
  const shadowPx = size >= 52 ? 4 : 3;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          width: size,
          height: size,
          backgroundColor: TONES[tone],
          borderRadius: round ? radii.pill : radii.control,
        },
        hardShadow(shadowPx),
        pressed && sunk(shadowPx),
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.46)} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: border.width,
    borderColor: colors.ink,
  },
});
