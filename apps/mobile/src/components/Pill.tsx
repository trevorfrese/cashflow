import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { colors, radii } from '@/theme';

export type PillTone = 'neutral' | 'paid' | 'due' | 'late' | 'info' | 'gold';

const tones: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
  paid: { bg: colors.successBg, fg: colors.paid },
  due: { bg: colors.warningBg, fg: colors.dueSoon },
  late: { bg: colors.dangerBg, fg: colors.late },
  info: { bg: colors.infoBg, fg: colors.primary },
  gold: { bg: colors.cream, fg: colors.bronze },
};

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: PillTone }) {
  const t = tones[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text variant="caption" style={{ color: t.fg }}>
        {label}
      </Text>
    </View>
  );
}

/** Map product statuses onto pill tones and short labels. */
export function statusPill(status: string): { label: string; tone: PillTone } {
  switch (status) {
    case 'PAID':
    case 'SUCCEEDED':
    case 'APPROVED':
    case 'ACTIVE':
    case 'LINKED':
      return { label: title(status), tone: 'paid' };
    case 'SCHEDULED':
    case 'COLLECTING':
    case 'PROCESSING':
    case 'PENDING':
    case 'SUBMITTED':
      return { label: title(status), tone: 'due' };
    case 'LATE':
    case 'FAILED':
    case 'DECLINED':
    case 'ERROR':
      return { label: title(status), tone: 'late' };
    case 'NEEDS_INFO':
      return { label: 'Needs info', tone: 'info' };
    default:
      return { label: title(status), tone: 'neutral' };
  }
}

function title(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    alignSelf: 'flex-start',
  },
});
