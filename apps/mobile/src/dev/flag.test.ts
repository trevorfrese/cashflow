import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (value: string | undefined) => {
  vi.resetModules();
  if (value === undefined) vi.stubEnv('EXPO_PUBLIC_DEV_TOOLS', undefined as unknown as string);
  else vi.stubEnv('EXPO_PUBLIC_DEV_TOOLS', value);
  return (await import('./flag')).DEV_TOOLS;
};

afterEach(() => vi.unstubAllEnvs());

describe('DEV_TOOLS', () => {
  it('is off unless EXPO_PUBLIC_DEV_TOOLS is exactly "true"', async () => {
    expect(await load(undefined)).toBe(false);
    expect(await load('')).toBe(false);
    expect(await load('false')).toBe(false);
    expect(await load('1')).toBe(false);
    expect(await load('TRUE')).toBe(false);
  });

  it('is on when the local .env sets it', async () => {
    expect(await load('true')).toBe(true);
  });
});

describe('the dev components with the flag off', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'DevTools.tsx'),
    'utf8',
  );

  // Each exported component must hand back its children (or nothing) before it touches a
  // hook, a listener, or the network. The guard is the first statement of the function.
  it.each([
    ['DevToolsProvider', 'return <>{children}</>;'],
    ['DevTapTarget', 'return <>{children}</>;'],
    ['DevIndicator', 'return null;'],
  ])('%s returns before doing anything', (name, inert) => {
    const start = source.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(source.indexOf('{\n', source.indexOf(')', start)) + 2);
    expect(body.trimStart().startsWith(`if (!DEV_TOOLS) ${inert}`)).toBe(true);
  });

  it('exports no other component that could run without the guard', () => {
    const exported = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(
      [
        'DevIndicator',
        'DevTapTarget',
        'DevToolsProvider',
        'useDevTools',
        'useDevWalkthrough',
      ].sort(),
    );
  });
});
