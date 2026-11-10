import { useId } from 'react';
import Svg, { Circle, Defs, G, Mask, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

/** The cents symbol: an open C plus a vertical bar. */
const CENT_ARC = 'M117.92 83.29 A26 26 0 1 0 117.92 116.71';
const CENT_BAR = 'M100 55.5 V81.5 M100 118.5 V144.5';
/** The same symbol grown outward, drawn underneath as the ink outline. */
const CENT_ARC_OUT = 'M120.24 86.53 A26 26 0 1 0 120.24 113.47';
const CENT_BAR_OUT = 'M100 51.5 V81.5 M100 118.5 V148.5';

/**
 * The CashFlow coin from the final board of the brand canvas: a flat two-gold coin with ink
 * outlines, a hard ink drop shadow, and the cents symbol pressed into the face (a 1.5px inner
 * shadow on its top-left walls). `lineColor` swaps the ink for the deep gold or night variants.
 */
export function CoinMark({
  size = 64,
  lineColor = colors.ink,
}: {
  size?: number;
  lineColor?: string;
}) {
  const maskId = `coin-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" accessibilityRole="image">
      <Defs>
        <Mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <G fill="none" stroke="#FFFFFF" strokeWidth="14">
            <Path d={CENT_ARC} />
            <Path d={CENT_BAR} />
          </G>
        </Mask>
      </Defs>
      <Circle cx="107" cy="107" r="82" fill={lineColor} />
      <Circle cx="100" cy="100" r="82" fill={colors.gold} stroke={lineColor} strokeWidth="6" />
      <Circle cx="100" cy="100" r="58" fill={colors.coinGold} stroke={lineColor} strokeWidth="4" />
      <G fill="none" stroke={lineColor} strokeWidth="22">
        <Path d={CENT_ARC_OUT} />
        <Path d={CENT_BAR_OUT} />
      </G>
      <G mask={`url(#${maskId})`}>
        <Rect width="200" height="200" fill={lineColor} />
        <G fill="none" stroke={colors.gold} strokeWidth="14" transform="translate(1.5 1.5)">
          <Path d={CENT_ARC} />
          <Path d={CENT_BAR} />
        </G>
      </G>
    </Svg>
  );
}
