import { StyleSheet, View, type ViewProps } from 'react-native';

import { border, colors, hardShadow, radii, spacing, type ShadowSize } from '@/theme';

type Tone = 'surface' | 'paper' | 'night' | 'gold' | 'sky' | 'dusk';

const BG: Record<Tone, string> = {
  surface: colors.white,
  paper: colors.paper,
  night: colors.night,
  gold: colors.gold,
  sky: colors.sky,
  dusk: colors.dusk,
};

/** A framed box: 3px ink border, 14px corners, and a hard shadow unless `shadow` is none. */
export function Card({
  style,
  tone = 'surface',
  shadow = 'm',
  shadowColor,
  ...rest
}: ViewProps & { tone?: Tone; shadow?: ShadowSize | 'none'; shadowColor?: string }) {
  return (
    <View
      {...rest}
      style={[
        styles.card,
        { backgroundColor: BG[tone] },
        shadow !== 'none' && hardShadow(shadow, shadowColor),
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.sm,
  },
});
