import { createHash } from 'node:crypto';

import type { CommercePlatform, DailySales, IsoDate } from '@cashflow/shared';
import {
  CommercePlatform as CommercePlatformSchema,
  addDays,
  parseIsoDate,
} from '@cashflow/shared';

import {
  SCENARIOS,
  parseScenario,
  type Scenario,
  type ScenarioSpec,
} from '../bank-link/synthetic.ts';

/**
 * Deterministic synthetic platform sales for the mock commerce provider. It shares the
 * scenario vocabulary with the sandbox bank so one keyword describes a business on both
 * sides: a `declining` POS link and a `declining` bank link tell the same story. The POS
 * sees every sale on the day it happens, so its monthly totals are steadier than the bank's
 * batched deposits, and it also reports refunds, chargebacks, and order counts.
 *
 * `sales_<dollars>` pins monthly gross sales (an alias for the bank's `rev_<dollars>`).
 * A platform keyword (`square`, `toast`, ...) in the token overrides the requested platform.
 */

interface Params {
  trend: number;
  seasonality: number;
  dailyNoise: number;
  monthlyNoise: number;
  /** Days of history the platform holds. */
  days: number;
  refundRate: number;
  chargebackRate: number;
  cardShare: number;
  collapse?: { at: number; depth: number };
}

const BASE: Params = {
  trend: 0.06,
  seasonality: 0.08,
  dailyNoise: 0.14,
  monthlyNoise: 0.04,
  days: 365,
  refundRate: 0.012,
  chargebackRate: 0.0015,
  cardShare: 0.85,
};

const PARAMS: Record<Scenario, Params> = {
  healthy: BASE,
  growing: { ...BASE, trend: 0.45 },
  thin_margin: BASE,
  declining: { ...BASE, trend: -0.1, collapse: { at: 0.6, depth: 0.55 } },
  volatile: { ...BASE, dailyNoise: 0.5, monthlyNoise: 0.3 },
  overdrafts: BASE,
  heavy_debt: BASE,
  seasonal: { ...BASE, seasonality: 0.45 },
  new_business: { ...BASE, days: 120 },
  low_balance: BASE,
  no_balance: { ...BASE, days: 0 },
  batched: BASE,
};

export interface CommerceSpec extends ScenarioSpec {
  platform: CommercePlatform;
}

export function parseCommerceScenario(token: string, platform: CommercePlatform): CommerceSpec {
  const lower = token.toLowerCase();
  const spec = parseScenario(lower.replace(/sales_(\d+)/g, 'rev_$1'));
  const named = CommercePlatformSchema.options.find((p) => lower.includes(p.toLowerCase()));
  return { ...spec, platform: named ?? platform };
}

export function encodeCommerceItemId(spec: CommerceSpec, seedHex: string): string {
  return `mock_pos_${spec.platform}_${spec.scenario}_r${spec.monthlyRevenueCents}_${seedHex}`;
}

export function decodeCommerceItemId(itemId: string): { spec: CommerceSpec; seedHex: string } {
  const m = /^mock_pos_([A-Z]+)_([a-z_]+)_r(\d+)_([0-9a-f]+)$/.exec(itemId);
  if (!m) {
    return {
      spec: { ...parseScenario('healthy'), platform: 'SQUARE' },
      seedHex: createHash('sha256').update(itemId).digest('hex').slice(0, 12),
    };
  }
  const platform = CommercePlatformSchema.safeParse(m[1]);
  const scenario = (SCENARIOS as readonly string[]).includes(m[2]!)
    ? (m[2] as Scenario)
    : 'healthy';
  return {
    spec: {
      scenario,
      monthlyRevenueCents: Number(m[3]),
      rentCents: 0,
      platform: platform.success ? platform.data : 'SQUARE',
    },
    seedHex: m[4]!,
  };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function weekday(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dayOfYear(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);
}

// Same weekly shape as the sandbox bank: closed Mondays, busiest at the weekend.
const WEEKDAY_WEIGHT = [1.1, 0, 0.8, 0.8, 0.9, 1.4, 1.5];
const WEEK_WEIGHT_SUM = WEEKDAY_WEIGHT.reduce((a, b) => a + b, 0);

export interface SyntheticSales {
  dailySales: DailySales[];
  connectedSince: IsoDate;
}

export function generateSales(spec: CommerceSpec, seedHex: string, asOf: IsoDate): SyntheticSales {
  const p = PARAMS[spec.scenario];
  const start = addDays(asOf, -Math.max(p.days - 1, 0));
  if (p.days === 0) return { dailySales: [], connectedSince: asOf };

  // A different seed stream from the bank so the two sources agree in shape but not tick for tick.
  const rand = mulberry32(parseInt(seedHex.slice(0, 8), 16) ^ 0x5a17e5 || 1);
  const weeklyRevenue = (spec.monthlyRevenueCents * 12) / 52;
  const avgTicket = 2400 + Math.floor(rand() * 4000);
  const out: DailySales[] = [];
  let monthLevel = 1;
  let currentMonth = '';

  for (let i = 0; i < p.days; i++) {
    const date = addDays(start, i);
    const monthKey = date.slice(0, 7);
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      monthLevel = Math.exp(normal(rand) * p.monthlyNoise);
    }
    const progress = i / Math.max(p.days - 1, 1);
    let trendFactor = 1 + p.trend * (progress - 0.5);
    if (p.collapse && progress > p.collapse.at) {
      trendFactor *= 1 - (p.collapse.depth * (progress - p.collapse.at)) / (1 - p.collapse.at);
    }
    const seasonFactor =
      1 + p.seasonality * Math.sin(((dayOfYear(date) - 105) / 365) * 2 * Math.PI);
    const dayShare = WEEKDAY_WEIGHT[weekday(date)]! / WEEK_WEIGHT_SUM;
    if (dayShare === 0) continue;

    const level = trendFactor * seasonFactor * monthLevel;
    const gross = Math.round(
      weeklyRevenue * level * dayShare * Math.exp(normal(rand) * p.dailyNoise),
    );
    if (gross <= 0) continue;
    const refunds = rand() < 0.6 ? Math.round(gross * p.refundRate * (0.5 + rand())) : 0;
    const chargebacks = rand() < 0.08 ? Math.round(gross * p.chargebackRate * 8) : 0;
    out.push({
      date,
      grossCents: gross,
      refundsCents: refunds,
      chargebacksCents: chargebacks,
      orderCount: Math.max(1, Math.round(gross / avgTicket)),
      cardShareBps: Math.round(
        10_000 * Math.min(1, Math.max(0, p.cardShare + normal(rand) * 0.03)),
      ),
    });
  }
  return { dailySales: out, connectedSince: start };
}
