import { mulberry32, normal } from '../providers/bank-link/business-sim.ts';

/** Seeded random helpers for the evals. Nothing here reads a clock or `Math.random`. */

/** FNV-1a hash of a string to an unsigned 32 bit integer. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  uniform(min: number, max: number): number;
  normal(mean?: number, sd?: number): number;
  /** Log normal with the given median and log scale sigma. */
  lognormal(median: number, sigma: number): number;
  chance(probability: number): boolean;
  int(min: number, maxInclusive: number): number;
  /** Pick a key with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K;
}

/** An independent stream for each (seed, label) pair. */
export function createRng(seed: string | number, label: string | number = ''): Rng {
  const rand = mulberry32(hash32(`${seed}/${label}`) || 1);
  const rng: Rng = {
    next: rand,
    uniform: (min, max) => min + (max - min) * rand(),
    normal: (mean = 0, sd = 1) => mean + sd * normal(rand),
    lognormal: (median, sigma) => median * Math.exp(sigma * normal(rand)),
    chance: (probability) => rand() < probability,
    int: (min, maxInclusive) => min + Math.floor(rand() * (maxInclusive - min + 1)),
    weighted: <K extends string>(weights: Readonly<Record<K, number>>): K => {
      const keys = Object.keys(weights) as K[];
      const total = keys.reduce((sum, k) => sum + weights[k], 0);
      let x = rand() * total;
      for (const k of keys) {
        x -= weights[k];
        if (x < 0) return k;
      }
      return keys[keys.length - 1]!;
    },
  };
  return rng;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
