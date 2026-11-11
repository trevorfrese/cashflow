import { createHash } from 'node:crypto';

import type { CommercePlatform, DailySales, IsoDate } from '@cashflow/shared';
import {
  CommercePlatform as CommercePlatformSchema,
  addDays,
  daysBetween,
  parseIsoDate,
} from '@cashflow/shared';

import { WEEKDAY_WEIGHT, WEEK_WEIGHT_SUM, mulberry32, normal } from '../bank-link/business-sim.ts';
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

/**
 * Sandbox keywords that change what the platform reports, beyond the sales level. See
 * `apps/api/README.md`.
 */
export const COMMERCE_FLAGS = [
  /** The platform account is in another business's legal name. */
  'owner_mismatch',
  /** The tax id on the platform account ends differently from the business's. */
  'taxid_mismatch',
  /** The platform pays out to an account that is not connected. */
  'payout_elsewhere',
  /** Sales that are never paid out: gross sales run well above payouts. */
  'unsettled',
  /** The platform account was created 45 days before it was connected. */
  'new_account',
  /** The token cannot be refreshed after the connect date: the owner must reconnect. */
  'expired',
  /** A delegated seat whose report pull fails (the report layout changed). */
  'seat_layout_changed',
  /** A delegated seat the merchant has not activated yet. */
  'seat_inactive',
  /** Pulls after the connect date report different sales for days that were final. */
  'rewrites',
] as const;
export type CommerceFlag = (typeof COMMERCE_FLAGS)[number];

export function parseCommerceFlags(token: string): CommerceFlag[] {
  const lower = token.toLowerCase();
  return COMMERCE_FLAGS.filter((f) => lower.includes(f));
}

export function encodeCommerceItemId(
  spec: CommerceSpec,
  seedHex: string,
  anchor?: IsoDate,
  flags: readonly CommerceFlag[] = [],
): string {
  const base = `mock_pos_${spec.platform}_${spec.scenario}_r${spec.monthlyRevenueCents}_${seedHex}`;
  const a = anchor ? `_a${anchor.replaceAll('-', '')}` : '';
  const x = flags.length > 0 ? `_x${flags.join('-')}` : '';
  return `${base}${a}${x}`;
}

export interface DecodedCommerceItem {
  spec: CommerceSpec;
  seedHex: string;
  anchor: IsoDate | null;
  flags: CommerceFlag[];
}

export function decodeCommerceItemId(itemId: string): DecodedCommerceItem {
  const m = /^mock_pos_([A-Z]+)_([a-z_]+)_r(\d+)_([0-9a-f]+)(?:_a(\d{8}))?(?:_x([a-z_-]+))?$/.exec(
    itemId,
  );
  if (!m) {
    return {
      spec: { ...parseScenario('healthy'), platform: 'SQUARE' },
      seedHex: createHash('sha256').update(itemId).digest('hex').slice(0, 12),
      anchor: null,
      flags: [],
    };
  }
  const platform = CommercePlatformSchema.safeParse(m[1]);
  const scenario = (SCENARIOS as readonly string[]).includes(m[2]!)
    ? (m[2] as Scenario)
    : 'healthy';
  const a = m[5];
  return {
    spec: {
      scenario,
      monthlyRevenueCents: Number(m[3]),
      rentCents: 0,
      platform: platform.success ? platform.data : 'SQUARE',
    },
    seedHex: m[4]!,
    anchor: a ? `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}` : null,
    flags: (m[6]?.split('-') ?? []).filter((f): f is CommerceFlag =>
      (COMMERCE_FLAGS as readonly string[]).includes(f),
    ),
  };
}

export interface SyntheticSales {
  dailySales: DailySales[];
  connectedSince: IsoDate;
}

function weekday(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dayOfYear(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  return Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);
}

/** The platform's seed stream: different from the bank's so the two do not agree tick for tick. */
function platformRand(seedHex: string): () => number {
  return mulberry32(parseInt(seedHex.slice(0, 8), 16) ^ 0x5a17e5 || 1);
}

function averageTicketCents(rand: () => number): number {
  return 2400 + Math.floor(rand() * 4000);
}

interface RowParams {
  refundRate: number;
  chargebackRate: number;
  cardShare: number;
}

/**
 * One day as the platform reports it, given that day's gross sales. Shared by the sandbox
 * generator and the forward generator so both describe a day the same way.
 */
function salesRow(
  rand: () => number,
  date: IsoDate,
  gross: number,
  avgTicket: number,
  p: RowParams,
): DailySales {
  const refunds = rand() < 0.6 ? Math.round(gross * p.refundRate * (0.5 + rand())) : 0;
  const chargebacks = rand() < 0.08 ? Math.round(gross * p.chargebackRate * 8) : 0;
  return {
    date,
    grossCents: gross,
    refundsCents: refunds,
    chargebacksCents: chargebacks,
    orderCount: Math.max(1, Math.round(gross / avgTicket)),
    cardShareBps: Math.round(10_000 * Math.min(1, Math.max(0, p.cardShare + normal(rand) * 0.03))),
  };
}

export function generateSales(spec: CommerceSpec, seedHex: string, asOf: IsoDate): SyntheticSales {
  return generateSalesAt(spec, seedHex, asOf, asOf);
}

/**
 * Sales as they stand on `asOf` for an account connected on `anchor`: exactly
 * `generateSales(spec, seedHex, anchor)` up to the anchor, then the same stream continues day
 * by day at the level it reached. A later pull sees the earlier pull's past unchanged.
 */
export function generateSalesAt(
  spec: CommerceSpec,
  seedHex: string,
  anchor: IsoDate,
  asOf: IsoDate,
): SyntheticSales {
  const p = PARAMS[spec.scenario];
  const start = addDays(anchor, -Math.max(p.days - 1, 0));
  if (p.days === 0) return { dailySales: [], connectedSince: anchor };
  const total = p.days + Math.max(0, daysBetween(anchor, asOf));

  const rand = platformRand(seedHex);
  const weeklyRevenue = (spec.monthlyRevenueCents * 12) / 52;
  const avgTicket = averageTicketCents(rand);
  const out: DailySales[] = [];
  let monthLevel = 1;
  let currentMonth = '';

  for (let i = 0; i < total; i++) {
    const date = addDays(start, i);
    const monthKey = date.slice(0, 7);
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      monthLevel = Math.exp(normal(rand) * p.monthlyNoise);
    }
    const progress = Math.min(1, i / Math.max(p.days - 1, 1));
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
    out.push(salesRow(rand, date, gross, avgTicket, p));
  }
  return { dailySales: out, connectedSince: start };
}

/**
 * Platform sales for a business whose sales path is already known, for example the
 * `dailySales` of `simulateBusiness`. Gross sales are the same sales the bank deposits come
 * from, so the two sources reconcile; refunds, chargebacks, order counts, and card share come
 * from the platform's own seed stream. Because rows are produced in date order from that
 * stream, the sales up to any date are a prefix of a longer path.
 */
export function generateSalesFromPath(
  path: ReadonlyArray<{ date: IsoDate; grossCents: number }>,
  seedHex: string,
): SyntheticSales {
  const first = path[0];
  if (!first) return { dailySales: [], connectedSince: '1970-01-01' };
  const rand = platformRand(seedHex);
  const avgTicket = averageTicketCents(rand);
  const dailySales: DailySales[] = [];
  for (const day of path) {
    if (day.grossCents <= 0) continue;
    dailySales.push(salesRow(rand, day.date, day.grossCents, avgTicket, BASE));
  }
  return { dailySales, connectedSince: first.date };
}
