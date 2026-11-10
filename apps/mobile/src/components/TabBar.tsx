import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { border, colors, hardShadow, radii, spacing } from '@/theme';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICONS: Record<string, IconName> = {
  index: 'home',
  schedule: 'calendar',
  history: 'clock',
  settings: 'settings',
};

/** Pill navigation from the design system: a white bar of icons, the active one on gold. */
export function TabBar({ state, descriptors, emitter, navigateToTab, insets }: TabBarProps) {
  const bottom = Math.max(insets.bottom, Platform.OS === 'web' ? 18 : 12);
  return (
    <View style={[styles.wrap, { paddingBottom: bottom }]}>
      <View style={[styles.bar, hardShadow('m')]} accessibilityRole="tablist">
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key] ?? {};
          const label = options?.title ?? route.name;
          const focused = state.index === index;
          const onPress = () => {
            const event = emitter.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigateToTab(route.key);
          };
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={onPress}
              style={[styles.item, focused && styles.itemActive]}
            >
              <Icon name={ICONS[route.name] ?? 'home'} size={24} strokeWidth={2.5} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, backgroundColor: colors.paper },
  bar: {
    flexDirection: 'row',
    padding: 6,
    gap: 4,
    backgroundColor: colors.white,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.pill,
  },
  item: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: border.thin,
    borderColor: 'transparent',
  },
  itemActive: { backgroundColor: colors.gold, borderColor: colors.ink },
});
