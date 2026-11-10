import { Redirect } from 'expo-router';

import { SplashView } from '@/components';
import { useAuth } from '@/lib/auth';

export default function Welcome() {
  const { user } = useAuth();
  if (user) return <Redirect href="/(tabs)" />;
  return <SplashView />;
}
