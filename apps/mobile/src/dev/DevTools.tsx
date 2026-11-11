import type { DevClock, DevPersona, DevSession, DevWalkthrough } from '@cashflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { useAuth } from '@/lib/auth';
import { setSimulatedToday } from '@/lib/forms';
import { storage } from '@/lib/storage';
import { border, colors, fonts, hardShadow, radii, spacing } from '@/theme';

import { devApi } from './api';
import { DevMenu } from './DevMenu';
import { DEV_TOOLS } from './flag';
import { createTapDetector } from './taps';

const PERSONA_KEY = 'cashflow.devPersona';

interface DevToolsState {
  /** The persona the app is signed in as, when it got there through the dev menu. */
  persona: DevPersona | null;
  clock: DevClock | null;
  openMenu: () => void;
  closeMenu: () => void;
  /** Sign in as a persona and land on its screen. Rejects with the API's error. */
  switchTo: (key: string, options?: { reset?: boolean }) => Promise<DevSession>;
  /** Forget the persona and sign out to the welcome screen. */
  leave: () => Promise<void>;
  /** Re-read the clock and drop cached queries, after time moved or data was rebuilt. */
  refresh: (clock?: DevClock) => Promise<void>;
}

const Ctx = createContext<DevToolsState | null>(null);

/** Null when the dev tools flag is off, so callers need no flag check of their own. */
export function useDevTools(): DevToolsState | null {
  return useContext(Ctx);
}

/**
 * The preset inputs of the fresh applicant the app is signed in as, or null. Onboarding
 * screens prefill from it and show `summary`, so the preset is visible, not magic.
 */
export function useDevWalkthrough(): DevWalkthrough | null {
  return useContext(Ctx)?.persona?.walkthrough ?? null;
}

function land(landing: DevSession['landing']) {
  router.replace('/(tabs)');
  // The tab navigator has to be in place before a screen is pushed on top of it.
  setTimeout(() => {
    if (landing.screen === 'HISTORY') router.replace('/(tabs)/history');
    else if (landing.screen === 'BUSINESS_NEW') router.push('/business/new');
    else if (landing.screen === 'CONNECTIONS') router.push('/connections');
    else if (landing.screen === 'APPLICATION' && landing.applicationId) {
      router.push({ pathname: '/application/[id]', params: { id: landing.applicationId } });
    }
  }, 60);
}

/**
 * Mounted once, inside the auth provider. With the flag off it renders its children and
 * nothing else. With it on it owns the menu, the persona indicator, the toast, the web
 * keyboard shortcut, and the `?devPersona=` link the dev home page uses.
 */
export function DevToolsProvider({ children }: { children: ReactNode }) {
  if (!DEV_TOOLS) return <>{children}</>;
  return <EnabledProvider>{children}</EnabledProvider>;
}

function EnabledProvider({ children }: { children: ReactNode }) {
  const { user, adoptSession, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [persona, setPersona] = useState<DevPersona | null>(null);
  const [clock, setClock] = useState<DevClock | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyClock = useCallback((next: DevClock | null) => {
    setClock(next);
    setSimulatedToday(next && next.aheadDays > 0 ? next.today : null);
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const refresh = useCallback(
    async (next?: DevClock) => {
      applyClock(next ?? (await devApi.clock().catch(() => null)));
      await queryClient.invalidateQueries();
    },
    [applyClock, queryClient],
  );

  const switchTo = useCallback(
    async (key: string, options: { reset?: boolean } = {}) => {
      const session = options.reset ? await devApi.resetPersona(key) : await devApi.session(key);
      await adoptSession({ user: session.user, tokens: session.tokens });
      setPersona(session.persona);
      await storage.set(PERSONA_KEY, JSON.stringify(session.persona));
      applyClock(await devApi.clock().catch(() => null));
      land(session.landing);
      showToast(`You are now ${session.persona.title}`);
      return session;
    },
    [adoptSession, applyClock, showToast],
  );

  const leave = useCallback(async () => {
    setPersona(null);
    await storage.remove(PERSONA_KEY);
    await signOut();
    router.replace('/welcome');
  }, [signOut]);

  // The clock, once, so "due today" and "overdue" agree with the API from the first render.
  useEffect(() => {
    void devApi
      .clock()
      .then(applyClock)
      .catch(() => undefined);
  }, [applyClock]);

  // The persona survives a reload, as long as the session it belongs to did.
  useEffect(() => {
    if (user === undefined) return;
    if (user === null) {
      setPersona(null);
      return;
    }
    void storage.get(PERSONA_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as DevPersona;
        if (saved.email === user.email) setPersona((current) => current ?? saved);
        else void storage.remove(PERSONA_KEY);
      } catch {
        void storage.remove(PERSONA_KEY);
      }
    });
  }, [user]);

  // Web: the keyboard shortcut, and the "open app as this persona" link from the dev home.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === 'Backquote') {
        event.preventDefault();
        setMenuOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    // The dev home page's phone preview shows the app in a frame and asks it to open the
    // menu by message. Only a page served from this machine is listened to.
    const onMessage = (event: MessageEvent) => {
      if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(event.origin)) return;
      if (event.data === 'cashflow-dev:open-menu') setMenuOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
    };
  }, []);
  const linkHandled = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (user === undefined || linkHandled.current) return;
    linkHandled.current = true;
    const url = new URL(window.location.href);
    const key = url.searchParams.get('devPersona');
    if (!key) return;
    url.searchParams.delete('devPersona');
    window.history.replaceState(null, '', url.toString());
    switchTo(key).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not sign in as that persona');
    });
  }, [user, switchTo, showToast]);

  const value = useMemo<DevToolsState>(
    () => ({
      persona: user ? persona : null,
      clock,
      openMenu: () => setMenuOpen(true),
      closeMenu: () => setMenuOpen(false),
      switchTo,
      leave,
      refresh,
    }),
    [user, persona, clock, switchTo, leave, refresh],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {menuOpen ? <DevMenu /> : null}
      {toast ? <DevToast message={toast} /> : null}
    </Ctx.Provider>
  );
}

/**
 * Wraps the brand mark. Five quick taps open the dev menu. With the flag off it is its
 * children and nothing more: no pressable, no handler.
 */
export function DevTapTarget({ children }: { children: ReactNode }) {
  if (!DEV_TOOLS) return <>{children}</>;
  return <EnabledTapTarget>{children}</EnabledTapTarget>;
}

function EnabledTapTarget({ children }: { children: ReactNode }) {
  const dev = useDevTools();
  const detector = useRef(createTapDetector()).current;
  return (
    <Pressable
      onPress={() => {
        if (detector.tap()) dev?.openMenu();
      }}
      // Not announced as a button: to everyone but a developer it is the logo.
      accessible={false}
      style={styles.tapTarget}
    >
      {children}
    </Pressable>
  );
}

/**
 * The persistent indicator while impersonating: a small tag in the top corner with the
 * persona's name. Tapping it reopens the menu. Rendered inside the phone frame.
 */
export function DevIndicator() {
  if (!DEV_TOOLS) return null;
  return <EnabledIndicator />;
}

function EnabledIndicator() {
  const dev = useDevTools();
  const insets = useSafeAreaInsets();
  if (!dev?.persona) return null;
  return (
    <Pressable
      onPress={dev.openMenu}
      accessibilityRole="button"
      accessibilityLabel={`Dev mode: signed in as ${dev.persona.title}. Open the dev menu`}
      style={[styles.indicator, { top: insets.top + 6 }]}
    >
      <Text style={styles.indicatorText} numberOfLines={1}>
        DEV · {dev.persona.title}
      </Text>
    </Pressable>
  );
}

function DevToast({ message }: { message: string }) {
  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <View style={[styles.toast, hardShadow('m', colors.gold)]} accessibilityRole="alert">
        <Text style={styles.toastText}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tapTarget: { alignSelf: 'flex-start' },
  indicator: {
    position: 'absolute',
    right: 8,
    maxWidth: 190,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.chip,
    borderWidth: border.thin,
    borderColor: colors.ink,
    backgroundColor: colors.night,
    zIndex: 50,
  },
  indicatorText: {
    fontFamily: fonts.bold,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1,
    color: colors.gold,
  },
  toastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 96,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    zIndex: 60,
  },
  toast: {
    backgroundColor: colors.night,
    borderWidth: border.width,
    borderColor: colors.ink,
    borderRadius: radii.control,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: 360,
  },
  toastText: { fontFamily: fonts.bold, fontSize: 14, lineHeight: 20, color: colors.gold },
});
