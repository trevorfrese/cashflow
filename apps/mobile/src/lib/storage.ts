import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Small key value store for auth tokens. Uses the device keychain or keystore through
 * expo-secure-store on iOS and Android. On web, where SecureStore is not available,
 * it falls back to localStorage so the app still runs in a browser for demos.
 */
export const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Storage can be unavailable in private browsing. The session then lives in memory only.
      }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Nothing to remove.
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
