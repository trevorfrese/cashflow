import { ActivityIndicator, Pressable, StyleSheet, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import { border, colors, fonts, hardShadow, radii, spacing, sunk } from '@/theme';

type Variant = 'primary' | 'secondary' | 'night' | 'azure' | 'danger' | 'text';
type Size = 'sm' | 'md' | 'lg';

const SIZES: Record<
  Size,
  { minHeight: number; paddingHorizontal: number; fontSize: number; radius: number; shadow: number }
> = {
  sm: { minHeight: 44, paddingHorizontal: 16, fontSize: 14, radius: 8, shadow: 3 },
  md: { minHeight: 52, paddingHorizontal: 24, fontSize: 16, radius: radii.control, shadow: 4 },
  lg: { minHeight: 58, paddingHorizontal: 28, fontSize: 18, radius: 12, shadow: 5 },
};

const VARIANTS: Record<
  Variant,
  { bg: string; fg: string; pressedBg: string; shadowColor: string; boxed: boolean }
> = {
  primary: {
    bg: colors.gold,
    fg: colors.ink,
    pressedBg: colors.goldPressed,
    shadowColor: colors.ink,
    boxed: true,
  },
  secondary: {
    bg: colors.white,
    fg: colors.ink,
    pressedBg: colors.paper,
    shadowColor: colors.ink,
    boxed: true,
  },
  night: {
    bg: colors.night,
    fg: colors.gold,
    pressedBg: colors.ink,
    shadowColor: colors.gold,
    boxed: true,
  },
  azure: {
    bg: colors.azure,
    fg: colors.white,
    pressedBg: colors.azureDeep,
    shadowColor: colors.ink,
    boxed: true,
  },
  danger: {
    bg: colors.jetRed,
    fg: colors.white,
    pressedBg: '#C7361F',
    shadowColor: colors.ink,
    boxed: true,
  },
  text: {
    bg: 'transparent',
    fg: colors.ink,
    pressedBg: 'transparent',
    shadowColor: 'transparent',
    boxed: false,
  },
};

/**
 * Neo-brutal button: 3px ink border and a hard shadow. The shadow is the affordance, so the
 * button sinks into it while pressed. Disabled buttons go dashed and lose the shadow.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  /** Trailing icon, for example an arrow on the main call to action. */
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const inactive = disabled || loading;
  const s = SIZES[size];
  const v = VARIANTS[variant];
  const fg = inactive && v.boxed ? colors.disabledText : v.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: s.minHeight,
          paddingHorizontal: v.boxed ? s.paddingHorizontal : spacing.sm,
          borderRadius: s.radius,
          backgroundColor: pressed ? v.pressedBg : v.bg,
        },
        v.boxed && styles.boxed,
        v.boxed && !inactive && hardShadow(s.shadow, v.shadowColor),
        v.boxed && pressed && !inactive && sunk(s.shadow),
        v.boxed && inactive && styles.disabled,
        !v.boxed && inactive && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          <Text
            style={[
              styles.title,
              { fontSize: s.fontSize, color: fg },
              size === 'lg' && { fontFamily: fonts.display },
              !v.boxed && styles.underline,
            ]}
          >
            {title}
          </Text>
          {icon ? <Icon name={icon} size={s.fontSize + 4} color={fg} strokeWidth={3.5} /> : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  boxed: { borderWidth: border.width, borderColor: colors.ink },
  disabled: {
    backgroundColor: colors.disabledBg,
    borderColor: colors.disabledBorder,
    borderStyle: 'dashed',
  },
  title: { fontFamily: fonts.heading, lineHeight: 22, textAlign: 'center' },
  underline: {
    textDecorationLine: 'underline',
    fontFamily: fonts.bold,
  },
});
