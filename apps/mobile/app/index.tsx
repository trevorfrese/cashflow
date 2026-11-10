import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { CoinMark } from '@/components';
import { useAuth } from '@/lib/auth';
import { colors } from '@/theme';

export default function Index() {
  const { user } = useAuth();
  if (user === undefined) {
    return (
      <View style={styles.splash}>
        <CoinMark size={96} />
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  return <Redirect href={user ? '/(tabs)' : '/(auth)/sign-in'} />;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    backgroundColor: colors.background,
  },
});
