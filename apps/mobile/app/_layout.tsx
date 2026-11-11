import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DevIndicator, DevToolsProvider } from '@/dev/DevTools';
import { AuthProvider } from '@/lib/auth';
import { BusinessProvider } from '@/lib/business';
import { border, colors, fontAssets, hardShadow, radii } from '@/theme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 15_000 },
        },
      }),
  );
  const ready = fontsLoaded || fontError !== null;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return <View style={styles.stage} />;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BusinessProvider>
            <StatusBar style="dark" />
            <PhoneFrame>
              <DevToolsProvider>
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.background },
                  }}
                >
                  <Stack.Screen name="index" />
                  <Stack.Screen name="welcome" />
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen name="business/new" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="bank/connect" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="application/new" />
                  <Stack.Screen name="application/[id]" />
                  <Stack.Screen name="lease/new" />
                  <Stack.Screen name="plan/new" />
                  <Stack.Screen name="settings/rent" />
                  <Stack.Screen name="settings/businesses" />
                  <Stack.Screen name="settings/banks" />
                  <Stack.Screen name="connections/index" />
                  <Stack.Screen name="connections/pos" />
                  <Stack.Screen name="connections/authorize" />
                  <Stack.Screen name="connections/seat" />
                </Stack>
                <DevIndicator />
              </DevToolsProvider>
            </PhoneFrame>
          </BusinessProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * On the web build, keeps the app in a phone frame from the design canvas (390 by 844, ink
 * border, hard shadow) instead of stretching across a desktop window. Native platforms
 * render the app full screen.
 */
function PhoneFrame({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={styles.stage}>
      <View style={[styles.frame, hardShadow('xl')]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.stage,
    padding: 24,
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 390,
    maxHeight: 844,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.phone,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
});
