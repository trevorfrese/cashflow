import { Redirect } from 'expo-router';

import { SplashView } from '@/components';
import { useAuth } from '@/lib/auth';

/**
 * Entry route. Shows the splash while the session loads, then sends signed in users to the
 * app and everyone else to the welcome screen. The welcome screen has its own route because
 * "/" is also the home tab once signed in.
 */
export default function Index() {
  const { user } = useAuth();
  if (user === undefined) return <SplashView loading />;
  return <Redirect href={user ? '/(tabs)' : '/welcome'} />;
}
