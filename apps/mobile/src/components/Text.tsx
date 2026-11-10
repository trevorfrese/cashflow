import { Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { colors, type as typeScale } from '@/theme';

type Variant = keyof typeof typeScale;
type Tone =
  'default' | 'muted' | 'inverse' | 'primary' | 'link' | 'danger' | 'success' | 'gold' | 'sky';

const toneColor: Record<Tone, string> = {
  default: colors.text,
  muted: colors.textMuted,
  inverse: colors.white,
  primary: colors.azureDeep,
  link: colors.azureDeep,
  danger: colors.lateText,
  success: colors.paidText,
  gold: colors.gold,
  sky: colors.sky,
};

export function Text({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: RNTextProps & { variant?: Variant; tone?: Tone }) {
  return <RNText {...rest} style={[typeScale[variant], { color: toneColor[tone] }, style]} />;
}
