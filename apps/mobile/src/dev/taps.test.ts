import { describe, expect, it } from 'vitest';

import { createTapDetector, DEV_MENU_TAPS } from './taps';

describe('createTapDetector', () => {
  it('opens on the fifth quick tap, not before', () => {
    const d = createTapDetector();
    const results = [0, 150, 300, 450, 600].map((t) => d.tap(1000 + t));
    expect(results).toEqual([false, false, false, false, true]);
  });

  it('does not open on five slow taps', () => {
    const d = createTapDetector();
    const results = [0, 1000, 2000, 3000, 4000].map((t) => d.tap(t));
    expect(results).toEqual([false, false, false, false, false]);
  });

  it('starts over after a pause, so four quick taps and one late tap do not open', () => {
    const d = createTapDetector();
    for (const t of [0, 100, 200, 300]) expect(d.tap(t)).toBe(false);
    expect(d.tap(300 + DEV_MENU_TAPS.gapMs + 1)).toBe(false);
    // The late tap was the first of a new run: four more quick ones complete it.
    expect([100, 200, 300].map((t) => d.tap(1001 + t))).toEqual([false, false, false]);
    expect(d.tap(1500)).toBe(true);
  });

  it('needs all five inside the window even when each gap is short enough', () => {
    const d = createTapDetector({ count: 5, windowMs: 1000, gapMs: 400 });
    expect([0, 300, 600, 900, 1200].map((t) => d.tap(t))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('counts a new run after opening', () => {
    const d = createTapDetector();
    expect([0, 100, 200, 300, 400].map((t) => d.tap(t)).at(-1)).toBe(true);
    expect(d.tap(500)).toBe(false);
    expect([600, 700, 800].map((t) => d.tap(t))).toEqual([false, false, false]);
    expect(d.tap(900)).toBe(true);
  });

  it('can be reset', () => {
    const d = createTapDetector();
    for (const t of [0, 100, 200, 300]) d.tap(t);
    d.reset();
    expect(d.tap(400)).toBe(false);
  });

  it('uses five taps by default', () => {
    expect(DEV_MENU_TAPS.count).toBe(5);
  });
});
