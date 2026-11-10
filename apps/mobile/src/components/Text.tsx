import { Text as RNText, type TextProps as RNTextProps, StyleSheet } from 'react-native';

import { colors, type as typeScale } from '@/theme';

type Variant = keyof typeof typeScale;
type Tone = 'default' | 'muted' | 'inverse' | 'primary' | 'danger' | 'success';

const toneColor: Record<Tone, string> = {
  default: colors.text,
  muted: colors.textMuted,
  inverse: colors.onPrimary,
  primary: colors.primary,
  danger: colors.late,
  success: colors.paid,
};

export function Text({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: RNTextProps & { variant?: Variant; tone?: Tone }) {
  return (
    <RNText
      {...rest}
      style={[styles.base, typeScale[variant], { color: toneColor[tone] }, style]}
    />
  );
}

const styles = StyleSheet.create({
  base: { fontFamily: undefined },
});
