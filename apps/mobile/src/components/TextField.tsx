import { useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native';

import { Text } from './Text';
import { colors, radii, spacing } from '@/theme';

export function TextField({
  label,
  error,
  helper,
  prefix,
  style,
  ...input
}: TextInputProps & { label: string; error?: string | null; helper?: string; prefix?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text variant="caption" tone="muted" style={styles.label}>
        {label}
      </Text>
      <View
        style={[
          styles.field,
          focused && { borderColor: colors.primary },
          error ? { borderColor: colors.late } : null,
        ]}
      >
        {prefix ? (
          <Text variant="body" tone="muted" style={styles.prefix}>
            {prefix}
          </Text>
        ) : null}
        <TextInput
          {...input}
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          style={[styles.input, style]}
        />
      </View>
      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : helper ? (
        <Text variant="caption" tone="muted">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { textTransform: 'uppercase', letterSpacing: 0.6 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.control,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  prefix: { marginRight: 4 },
  input: { flex: 1, fontSize: 16, color: colors.text, paddingVertical: 12 },
});
