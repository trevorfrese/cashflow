/**
 * The one switch for the dev menu. Expo inlines `EXPO_PUBLIC_*` variables when it bundles,
 * so in a build without the flag this is the constant `false`: every dev component returns
 * its children untouched, nothing listens for taps or keys, and no dev route is ever
 * called. The API has its own gate (`ENABLE_DEV_TOOLS`) and does not exist in production.
 */
export const DEV_TOOLS = process.env.EXPO_PUBLIC_DEV_TOOLS === 'true';

const trim = (url: string | undefined, fallback: string) => (url || fallback).replace(/\/$/, '');

export const OPS_URL = trim(process.env.EXPO_PUBLIC_OPS_URL, 'http://localhost:3200');
export const DEV_HOME_URL = trim(process.env.EXPO_PUBLIC_DEV_HOME_URL, 'http://localhost:4100');

/** Shown wherever the menu explains how to open itself. Web only. */
export const DEV_MENU_SHORTCUT = 'Ctrl+`';
