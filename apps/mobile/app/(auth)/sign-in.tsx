import { LoginRequest } from '@cashflow/shared';
import { Link } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, CoinMark, Notice, Screen, Text, TextField } from '@/components';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

const DEMO = { email: 'demo@cashflow.local', password: 'demo-password-123' };

export default function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (values = { email, password }) => {
    const parsed = LoginRequest.safeParse(values);
    if (!parsed.success) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(parsed.data);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <CoinMark size={88} />
        <Text variant="display">CashFlow</Text>
        <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
          Buy now, pay later for small business rent.
        </Text>
      </View>
      {error ? <Notice tone="danger" message={error} /> : null}
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        placeholder="you@business.com"
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
        placeholder="At least 10 characters"
        onSubmitEditing={() => void submit()}
      />
      <Button title="Sign in" onPress={() => void submit()} loading={busy} />
      <Button
        title="Use the demo account"
        variant="secondary"
        onPress={() => {
          setEmail(DEMO.email);
          setPassword(DEMO.password);
          void submit(DEMO);
        }}
        disabled={busy}
      />
      <View style={styles.footer}>
        <Text variant="body" tone="muted">
          New here?{' '}
        </Text>
        <Link href="/(auth)/register">
          <Text variant="bodyStrong" tone="primary">
            Create an account
          </Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  footer: { flexDirection: 'row', justifyContent: 'center', paddingTop: spacing.md },
});
