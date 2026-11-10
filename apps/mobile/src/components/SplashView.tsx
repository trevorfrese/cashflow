import { router } from 'expo-router';
import { Image, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from './Button';
import { Text } from './Text';
import { border, colors, fonts, spacing } from '@/theme';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const city = require('../../assets/city-dusk.jpg');

/**
 * Splash from the design canvas: the dusk city illustration over a paper panel with the
 * wordmark and a single gold Sign in button.
 */
export function SplashView({ loading = false }: { loading?: boolean }) {
  return (
    <SafeAreaView style={styles.root} edges={['left', 'right']}>
      <View style={styles.imageWrap}>
        <Image
          source={city}
          style={styles.image}
          resizeMode="cover"
          accessibilityLabel="Illustrated city skyline at sunset"
        />
      </View>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>SPLIT RENT</Text>
        <Text style={styles.wordmark}>CashFlow</Text>
        <Button
          title="Sign in"
          size="lg"
          icon="arrow-right"
          loading={loading}
          onPress={() => router.push('/(auth)/sign-in')}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  imageWrap: {
    flex: 1,
    minHeight: 0,
    borderBottomWidth: border.width,
    borderBottomColor: colors.ink,
    backgroundColor: colors.night,
  },
  image: { width: '100%', height: '100%' },
  panel: { paddingHorizontal: 28, paddingTop: 20, paddingBottom: spacing.xl },
  eyebrow: {
    fontFamily: fonts.bold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 4,
    color: colors.azureDeep,
  },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 44,
    letterSpacing: -1,
    color: colors.azure,
    marginTop: 20,
    marginBottom: 20,
  },
});
