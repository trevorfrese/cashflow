import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton } from './IconButton';
import { Text } from './Text';
import { border, colors, spacing } from '@/theme';

/**
 * Page wrapper: safe area, optional back button and step label, display title, scrolling
 * content, and a footer that stays pinned above the keyboard for forms.
 */
export function Screen({
  title,
  subtitle,
  step,
  back = false,
  children,
  footer,
  scroll = true,
}: {
  title?: string;
  subtitle?: string;
  /** Small label beside the back button, for example "Step 2 of 4". */
  step?: string;
  back?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
}) {
  const body = (
    <>
      {back || step ? (
        <View style={styles.nav}>
          {back ? <IconButton icon="arrow-left" label="Back" onPress={goBack} /> : null}
          {step ? <Text variant="label">{step}</Text> : null}
        </View>
      ) : null}
      {title ? (
        <View style={styles.header}>
          <Text variant="display">{title}</Text>
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

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  nav: { flexDirection: 'row', alignItems: 'center', gap: spacing.smd, marginBottom: spacing.xs },
  header: { gap: spacing.sm, marginBottom: spacing.xs },
  footer: {
    padding: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: border.width,
    borderTopColor: colors.ink,
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
});
