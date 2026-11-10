import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Text } from './Text';
import { colors } from '@/theme';

const GRADE_COLOR: Record<string, string> = {
  A: colors.paid,
  B: colors.paid,
  C: colors.dueSoon,
  D: colors.dueSoon,
  F: colors.late,
};

/** Arc from twelve o'clock clockwise through `fraction` of the circle, as an SVG path. */
function arcPath(cx: number, cy: number, r: number, fraction: number): string {
  const f = Math.max(0, Math.min(0.9999, fraction));
  if (f === 0) return '';
  const end = -Math.PI / 2 + f * 2 * Math.PI;
  const x0 = cx;
  const y0 = cy - r;
  const x1 = cx + r * Math.cos(end);
  const y1 = cy + r * Math.sin(end);
  const largeArc = f > 0.5 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`;
}

/** Circular 0 to 100 gauge with the grade in the middle. */
export function ScoreGauge({
  score,
  grade,
  size = 148,
}: {
  score: number;
  grade: string;
  size?: number;
}) {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const progress = Math.max(0, Math.min(100, score)) / 100;
  const color = GRADE_COLOR[grade] ?? colors.textMuted;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.surfaceAlt}
          strokeWidth={stroke}
          fill="none"
        />
        {progress > 0 ? (
          <Path
            d={arcPath(size / 2, size / 2, r, progress)}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
      <Text variant="display" style={{ color, fontSize: 44, lineHeight: 50 }}>
        {grade}
      </Text>
      <Text variant="caption" tone="muted">
        Score {score}
      </Text>
    </View>
  );
}
