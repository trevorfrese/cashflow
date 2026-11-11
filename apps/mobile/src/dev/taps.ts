/**
 * Counts quick taps. `tap(now)` returns true on the tap that completes a run of `count`
 * taps, each within `gapMs` of the one before and all within `windowMs` of the first. A
 * slow tap starts a new run, so ordinary taps on the logo never add up to an opening.
 */
export interface TapDetector {
  tap(now?: number): boolean;
  reset(): void;
}

export const DEV_MENU_TAPS = { count: 5, windowMs: 2500, gapMs: 700 } as const;

export function createTapDetector(
  options: { count?: number; windowMs?: number; gapMs?: number } = {},
): TapDetector {
  const count = options.count ?? DEV_MENU_TAPS.count;
  const windowMs = options.windowMs ?? DEV_MENU_TAPS.windowMs;
  const gapMs = options.gapMs ?? DEV_MENU_TAPS.gapMs;
  let first = 0;
  let last = 0;
  let taps = 0;
  return {
    tap(now = Date.now()) {
      if (taps > 0 && (now - last > gapMs || now - first > windowMs)) taps = 0;
      if (taps === 0) first = now;
      taps += 1;
      last = now;
      if (taps < count) return false;
      taps = 0;
      return true;
    },
    reset() {
      taps = 0;
    },
  };
}
