import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from './Text';
import { colors, spacing } from '@/theme';

/**
 * Page wrapper: safe area, sandbox banner, optional title, scrolling content, and a
 * footer that stays pinned above the keyboard for forms.
 */
export function Screen({
  title,
  subtitle,
  children,
  footer,
  scroll = true,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
}) {
  const body = (
    <>
      {title ? (
        <View style={styles.header}>
          <Text variant="title">{title}</Text>
          {subtitle ? (
            <Text variant="body" tone="muted">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </>
  );
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <DemoBanner />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            contentInsetAdjustmentBehavior="automatic"
          >
            {body}
          </ScrollView>
        ) : (
          <View style={[styles.flex, styles.content]}>{body}</View>
        )}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function DemoBanner() {
  return (
    <View style={styles.banner} accessibilityRole="text">
      <Text variant="caption" style={{ color: colors.bronze }}>
        Sandbox. No real money moves in this app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  header: { gap: 4, marginBottom: spacing.sm },
  footer: {
    padding: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  banner: {
    backgroundColor: colors.cream,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
});
