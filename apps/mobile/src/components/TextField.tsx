import { useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps, View } from 'react-native';

import { Icon } from './Icon';
import { Text } from './Text';
import { border, colors, fonts, hardShadow, radii } from '@/theme';

/**
 * Text input from the design system: the label is always visible, the field is a white box
 * with a 3px ink border, focus adds a hard shadow and an azure border, an error tints the
 * field and gives it a red shadow. A currency prefix sits in a gold block on the left.
 */
export function TextField({
  label,
  error,
  helper,
  prefix,
  style,
  ...input
}: TextInputProps & { label: string; error?: string | null; helper?: string; prefix?: string }) {
  const [focused, setFocused] = useState(false);
  const disabled = input.editable === false;
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, disabled && { color: colors.textMuted }]}>{label}</Text>
      <View
        style={[
          styles.field,
          focused && styles.focused,
          error ? styles.errored : null,
          disabled && styles.disabled,
        ]}
      >
        {prefix ? (
          <View style={styles.prefix}>
            <Text style={styles.prefixText}>{prefix}</Text>
          </View>
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
          style={[styles.input, prefix ? styles.inputStrong : null, style]}
        />
      </View>
      {error ? (
        <View style={styles.errorRow}>
          <Icon name="alert" size={16} color={colors.lateText} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : helper ? (
        <Text variant="caption" tone="muted">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, minWidth: 0 },
  label: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.ink },
  field: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 52,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.control,
    backgroundColor: colors.white,
  },
  focused: { ...hardShadow('m'), borderColor: colors.azure },
  errored: { ...hardShadow('m', colors.jetRed), backgroundColor: colors.errorFieldBg },
  disabled: {
    backgroundColor: colors.disabledBg,
    borderColor: colors.disabledBorder,
    borderStyle: 'dashed',
  },
  prefix: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: colors.gold,
    borderRightWidth: border.width,
    borderRightColor: colors.ink,
    borderTopLeftRadius: radii.control - border.width,
    borderBottomLeftRadius: radii.control - border.width,
  },
  prefixText: { fontFamily: fonts.display, fontSize: 18, lineHeight: 22, color: colors.ink },
  input: {
    flex: 1,
    minWidth: 0,
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    fontFamily: fonts.regular,
    color: colors.ink,
  },
  inputStrong: { fontFamily: fonts.heading, fontSize: 18 },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18, color: colors.lateText },
});
