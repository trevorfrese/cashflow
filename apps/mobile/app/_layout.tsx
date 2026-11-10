import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/lib/auth';
import { BusinessProvider } from '@/lib/business';
import { colors } from '@/theme';

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 15_000 },
        },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BusinessProvider>
            <StatusBar style="dark" />
            <PhoneFrame>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="business/new" options={{ presentation: 'modal' }} />
                <Stack.Screen name="bank/connect" options={{ presentation: 'modal' }} />
                <Stack.Screen name="application/new" />
                <Stack.Screen name="application/[id]" />
                <Stack.Screen name="lease/new" />
                <Stack.Screen name="plan/new" />
              </Stack>
            </PhoneFrame>
          </BusinessProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * On the web build, keeps the app at phone width in the middle of the page instead of
 * stretching across a desktop window. Native platforms render the app full screen.
 */
function PhoneFrame({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={styles.stage}>
      <View style={styles.frame}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.text,
    padding: 24,
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 430,
    maxHeight: 932,
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
});
