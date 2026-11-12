import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Text } from './Text';
import { colors, fonts, radii } from '@/theme';

export type PillTone = 'neutral' | 'draft' | 'paid' | 'due' | 'late' | 'info' | 'gold';

const tones: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.stone, fg: colors.textMuted },
  draft: { bg: colors.stone, fg: colors.textMuted },
  paid: { bg: colors.successBg, fg: colors.paidText },
  due: { bg: colors.warningBg, fg: colors.ink },
  late: { bg: colors.dangerBg, fg: colors.lateText },
  info: { bg: colors.infoBg, fg: colors.azureDeep },
  gold: { bg: colors.gold, fg: colors.ink },
};

/** Status tag: a small flat label. No border or shadow, so it never reads as a button. */
export function Pill({
  label,
  tone = 'neutral',
  style,
}: {
  label: string;
  tone?: PillTone;
  style?: ViewStyle;
}) {
  const t = tones[tone];
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }, style]}>
      <Text style={[styles.text, { color: t.fg }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

/** Map product statuses onto tag tones and short labels. */
export function statusPill(status: string): { label: string; tone: PillTone } {
  switch (status) {
    case 'PAID':
    case 'SUCCEEDED':
      return { label: 'Paid', tone: 'paid' };
    case 'APPROVED':
    case 'ACTIVE':
      return { label: title(status), tone: 'paid' };
    // The same word the connections screen uses for a working connection.
    case 'LINKED':
      return { label: 'Connected', tone: 'paid' };
    case 'SCHEDULED':
      return { label: title(status), tone: 'info' };
    case 'PENDING':
    case 'SUBMITTED':
      return { label: title(status), tone: 'due' };
    case 'HELD':
      return { label: 'On hold', tone: 'due' };
    case 'LATE':
    case 'FAILED':
    case 'DECLINED':
    case 'ERROR':
    case 'RETURNED':
      return { label: title(status), tone: 'late' };
    case 'CHARGED_OFF':
      return { label: 'Unpaid', tone: 'late' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'VOIDED':
      return { label: 'Not owed', tone: 'neutral' };
    case 'NEEDS_INFO':
      return { label: 'Needs info', tone: 'gold' };
    case 'IN_REVIEW':
      return { label: 'In review', tone: 'due' };
    case 'DRAFT':
      return { label: 'Draft', tone: 'draft' };
    default:
      return { label: title(status), tone: 'neutral' };
  }
}

function title(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.chip,
    alignSelf: 'flex-start',
  },
  text: { fontFamily: fonts.bold, fontSize: 11, lineHeight: 14, letterSpacing: 1 },
});
