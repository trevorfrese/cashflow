import { RegisterRequest } from '@cashflow/shared';
import { Link } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Notice, Screen, Text, TextField } from '@/components';
import { describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

export default function Register() {
  const { register } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const parsed = RegisterRequest.safeParse({ fullName, email, password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      await register(parsed.data);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      back
      title="Create your account"
      subtitle="Sign in details for the owner of the business."
    >
      {error ? <Notice tone="danger" message={error} /> : null}
      <TextField
        label="Your name"
        value={fullName}
        onChangeText={setFullName}
        autoComplete="name"
        textContentType="name"
        error={errors.fullName}
      />
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={errors.email}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
        helper="At least 10 characters."
        error={errors.password}
      />
      <Button
        title="Create account"
        size="lg"
        icon="arrow-right"
        onPress={() => void submit()}
        loading={busy}
      />
      <View style={styles.footer}>
        <Text variant="body" tone="muted">
          Already have an account?{' '}
        </Text>
        <Link href="/(auth)/sign-in">
          <Text variant="bodyStrong" tone="link">
            Sign in
          </Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'center', paddingTop: spacing.md },
});
