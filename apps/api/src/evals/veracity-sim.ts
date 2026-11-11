import type {
  BankTransaction,
  CommercePlatform,
  DailySales,
  IsoDate,
  PlatformPayout,
  VisibleBankAccount,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS, addDays, parseIsoDate } from '@cashflow/shared';

import type { HazardEvent } from '../providers/bank-link/business-sim.ts';
import type { BankSourceFacts, CommerceSourceFacts, VeracityInput } from '../veracity/types.ts';
import { clamp, createRng, type Rng } from './random.ts';

/**
 * The data veracity side of the synthetic population: what each applicant's connections look
 * like (who the bank and the platform say the accounts belong to, how they were connected,
 * where payouts go), the honest messiness that real connections have, five fraud archetypes
 * that the veracity checks exist to catch, and connection failures.
 *
 * Everything here draws from its own random stream (`veracity/<index>/<attempt>`), after the
 * original draw, so the businesses the original population drew are unchanged: their cash
 * flows, hazards and stated figures are the same. What changes is what a connection shows of
 * them, and 2.5% of applicants who become one of the new fraud archetypes.
 *
 * Every rate below is a choice, not a measurement, and is documented in evals/README.md.
 */

export const NEW_FRAUD_TYPES = [
  'unsettled_sales',
  'borrowed_account',
  'fresh_pos_account',
  'hidden_accounts',
  'rewritten_history',
] as const;
export type NewFraudType = (typeof NEW_FRAUD_TYPES)[number];

/** Honest messiness and connection events, as tags. Several can apply to one applicant. */
export const HONEST_TAGS = [
  'personal_account',
  'owner_nickname',
  'unlisted_holder',
  'legacy_bank',
  'unshared_savings',
  'savings_transfers',
  'new_bank_account',
  'late_posting',
  'resync_minor',
  'resync_duplicates',
  'bank_pull_fails',
  'pos_trading_name',
  'pos_owner_name',
  'pos_other_name',
  'pos_tax_typo',
  'second_payout_connected',
  'second_payout_unconnected',
  'multi_location',
  'processor_holds',
  'split_deposits',
  'payout_rounding',
  'platform_switch',
  'pos_token_expired',
  'seat_pull_fails',
] as const;
export type HonestTag = (typeof HONEST_TAGS)[number];

/** Share of all applicants who become one of the new fraud archetypes, in basis points. */
export const NEW_FRAUD_SHARE_BPS = 250;

/** Honest rates, as probabilities. Choices; see evals/README.md. */
export const HONEST_RATES = {
  personalAccount: 0.06,
  ownerNickname: 0.04,
  unlistedHolder: 0.01,
  legacyBank: 0.2,
  unsharedSavings: 0.25,
  savingsTransfers: 0.12,
  newBankAccount: 0.02,
  priorPull: 0.6,
  latePosting: 0.3,
  resyncMinor: 0.015,
  resyncDuplicates: 0.005,
  bankPullFails: 0.005,
  posTradingName: 0.2,
  posOwnerName: 0.03,
  posOtherName: 0.02,
  posTaxReported: 0.7,
  posTaxTypo: 0.02,
  secondPayoutConnected: 0.03,
  secondPayoutUnconnected: 0.03,
  multiLocation: 0.08,
  processorHolds: 0.06,
  splitDeposits: 0.04,
  payoutRounding: 0.1,
  posTokenExpired: 0.02,
  seatPullFails: 0.08,
} as const;

export interface ApplicantVeracity {
  legalName: string;
  dba: string | null;
  ownerNames: string[];
  taxIdLast4: string;
  /** The new fraud archetype, when this applicant is one. */
  fraud: NewFraudType | null;
  tags: HonestTag[];
  bank: {
    mask: string;
    institutionAuthorized: boolean;
    ownerNames: string[];
    accountType: 'BUSINESS' | 'PERSONAL';
    /** Days before the application the account was opened. */
    openedDaysBefore: number;
    unshared: VisibleBankAccount[];
    pullFails: boolean;
  };
  /** Days before the application of an earlier pull of the same connection. 0 for none. */
  priorPullDaysBefore: number;
  pos: {
    legalName: string | null;
    taxIdLast4: string | null;
    createdDaysBefore: number;
    accessMethod: 'DIRECT_OAUTH' | 'DELEGATED_SEAT';
    pullFails: boolean;
  } | null;
  /** Masks for the extra accounts the scenarios use. */
  secondMask: string;
  hiddenMask: string;
  /** Fraud parameters. */
  inflation: number;
  burstDays: number;
  unseenVariant: boolean;
}

const ADJECTIVES = [
  'Blue',
  'Copper',
  'Golden',
  'Harbor',
  'Maple',
  'Northside',
  'Silver',
  'Cedar',
  'Juniper',
  'Lantern',
  'Willow',
  'Granite',
  'Orchard',
  'Riverside',
  'Summit',
  'Meadow',
];
const NOUNS = [
  'Door',
  'Kettle',
  'Fern',
  'Anchor',
  'Oak',
  'Sparrow',
  'Bridge',
  'Lamp',
  'Stone',
  'Field',
  'Ridge',
  'Harvest',
  'Compass',
  'Bell',
];
const KINDS: Record<string, string[]> = {
  restaurant: ['Kitchen', 'Bakery', 'Cafe', 'Taqueria', 'Bistro'],
  retail: ['Goods', 'Books', 'Outfitters', 'Supply', 'Gallery'],
  personal_services: ['Salon', 'Barbers', 'Spa', 'Studio'],
  fitness: ['Fitness', 'Yoga', 'Climbing', 'Athletics'],
  professional_services: ['Design', 'Print Shop', 'Accounting', 'Signs'],
  auto_services: ['Auto Repair', 'Tire', 'Collision', 'Detailing'],
};
const SUFFIXES = ['LLC', 'Inc', 'Co', 'LLC'];
/** First names with a common nickname, then plain ones. */
const NICK_FIRST: ReadonlyArray<readonly [string, string]> = [
  ['Robert', 'Bob'],
  ['William', 'Bill'],
  ['Elizabeth', 'Liz'],
  ['Katherine', 'Kate'],
  ['Michael', 'Mike'],
  ['James', 'Jim'],
  ['Margaret', 'Maggie'],
  ['Jennifer', 'Jen'],
  ['Daniel', 'Dan'],
  ['Patricia', 'Pat'],
];
const FIRST = [
  'Dana',
  'Priya',
  'Sam',
  'Avery',
  'Jordan',
  'Casey',
  'Riley',
  'Morgan',
  'Ana',
  'Wei',
  'Omar',
  'Lena',
  'Tomas',
  'Grace',
  'Malik',
];
const LAST = [
  'Rivera',
  'Okafor',
  'Natarajan',
  'Lindqvist',
  'Whitlock',
  'Okonkwo',
  'Abernathy',
  'Castellanos',
  'Chen',
  'Haddad',
  'Novak',
  'Brennan',
  'Iyer',
  'Moreau',
  'Sato',
];

const pick = <T>(rng: Rng, list: readonly T[]): T => list[rng.int(0, list.length - 1)]!;
const mask = (rng: Rng) => String(rng.int(1000, 9999));

/** Spelling variants a platform or a bank uses for the same name. */
function formatVariant(rng: Rng, name: string): string {
  const v = rng.int(0, 3);
  if (v === 0) return name.toUpperCase();
  if (v === 1) return name.replace(/\bLLC\b/, 'L.L.C.').replace(/\bInc\b/, 'Inc.');
  if (v === 2) return name.replace(/\s+(LLC|Inc|Co)$/, '');
  return `${name.replace(/\s+(LLC|Inc|Co)$/, '')}, ${name.match(/(LLC|Inc|Co)$/)?.[0] ?? 'LLC'}`;
}

export interface VeracityDraw {
  veracity: ApplicantVeracity;
  /** Fields of the applicant a new fraud archetype overrides. */
  overrides: {
    statedMonthlyRevenueCents?: number;
    requestedRentCents?: number;
    latentHealth?: number;
    historyDays?: number;
    pos?: { platform: CommercePlatform; days: number } | null;
    /** Replaces the forward hazards (events after the application date). */
    forwardEvents?: HazardEvent[];
    /** Added before the application. */
    pastEvents?: HazardEvent[];
    params?: { loan?: number; mcaDaily?: number };
  };
}

export interface DrawContext {
  seed: string | number;
  index: number;
  attempt: number;
  fraud: string | null;
  archetype: string;
  industry: string;
  applicationDate: IsoDate;
  historyDays: number;
  timeInBusinessMonths: number;
  revenueAtApplicationCents: number;
  statedMonthlyRevenueCents: number;
  rentCents: number;
  pos: { platform: CommercePlatform; days: number } | null;
  drawForwardHazards: (rng: Rng, health: number) => HazardEvent[];
}

const PLATFORMS: readonly CommercePlatform[] = ['SQUARE', 'TOAST', 'SHOPIFY', 'CLOVER', 'STRIPE'];
const roundTo = (cents: number, increment: number) =>
  Math.max(increment, Math.round(cents / increment) * increment);

export function drawVeracity(ctx: DrawContext): VeracityDraw {
  const rng = createRng(ctx.seed, `veracity/${ctx.index}/${ctx.attempt}`);
  const R = HONEST_RATES;
  const base = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} ${pick(rng, KINDS[ctx.industry] ?? ['Shop'])}`;
  const legalName = `${base} ${pick(rng, SUFFIXES)}`;
  const dba = rng.chance(0.6) ? base : null;
  const nick = rng.chance(0.4) ? pick(rng, NICK_FIRST) : null;
  const last = pick(rng, LAST);
  const ownerFirst = nick ? nick[0] : pick(rng, FIRST);
  const ownerNames = [`${ownerFirst} ${last}`];
  if (rng.chance(0.3)) ownerNames.push(`${pick(rng, FIRST)} ${pick(rng, LAST)}`);
  const taxIdLast4 = String(rng.int(1000, 9999));
  const overrides: VeracityDraw['overrides'] = {};
  const tags: HonestTag[] = [];

  let fraud: NewFraudType | null = null;
  if (ctx.fraud === null && ctx.historyDays > 0 && ctx.archetype !== 'new_business') {
    if (rng.chance(NEW_FRAUD_SHARE_BPS / 10_000)) fraud = pick(rng, NEW_FRAUD_TYPES);
  }
  const honest = ctx.fraud === null && fraud === null;
  let pos = ctx.pos;
  let historyDays = ctx.historyDays;

  const v: ApplicantVeracity = {
    legalName,
    dba,
    ownerNames,
    taxIdLast4,
    fraud,
    tags,
    bank: {
      mask: mask(rng),
      institutionAuthorized: true,
      ownerNames: [rng.chance(0.5) ? formatVariant(rng, legalName) : (dba ?? legalName)],
      accountType: 'BUSINESS',
      openedDaysBefore: historyDays + rng.int(0, 2000),
      unshared: [],
      pullFails: false,
    },
    priorPullDaysBefore: rng.chance(R.priorPull) ? rng.int(1, 20) : 0,
    pos: null,
    secondMask: mask(rng),
    hiddenMask: mask(rng),
    inflation: 1,
    burstDays: 0,
    unseenVariant: false,
  };
  const tag = (t: HonestTag, p: number) => {
    const hit = rng.chance(p);
    if (hit && honest) tags.push(t);
    return hit && honest;
  };

  // ---- The bank connection: honest variety ----
  if (tag('legacy_bank', R.legacyBank)) v.bank.institutionAuthorized = false;
  if (tag('personal_account', R.personalAccount)) {
    v.bank.accountType = 'PERSONAL';
    v.bank.ownerNames = [ownerNames[0]!];
  } else if (nick && tag('owner_nickname', R.ownerNickname)) {
    v.bank.accountType = 'PERSONAL';
    v.bank.ownerNames = [`${nick[1]} ${last}`];
  } else if (tag('unlisted_holder', R.unlistedHolder)) {
    // A spouse's account, or a holding company the owner did not list.
    v.bank.ownerNames = [rng.chance(0.5) ? `${pick(rng, FIRST)} ${last}` : `${last} Holdings LLC`];
    v.bank.accountType = rng.chance(0.5) ? 'PERSONAL' : 'BUSINESS';
  }
  if (tag('unshared_savings', R.unsharedSavings)) {
    v.bank.unshared = [
      { mask: v.secondMask, name: 'Business Savings', type: 'BUSINESS', shared: false },
    ];
  }
  tag('savings_transfers', R.savingsTransfers);
  if (
    historyDays > 330 &&
    ctx.timeInBusinessMonths >= 24 &&
    tag('new_bank_account', R.newBankAccount)
  ) {
    historyDays = rng.int(150, 300);
    overrides.historyDays = historyDays;
    v.bank.openedDaysBefore = historyDays;
    if (pos && pos.days > historyDays) {
      pos = { ...pos, days: historyDays };
      overrides.pos = pos;
    }
  }
  if (v.priorPullDaysBefore > 0) {
    tag('late_posting', R.latePosting);
    tag('resync_minor', R.resyncMinor);
    tag('resync_duplicates', R.resyncDuplicates);
  }
  if (tag('bank_pull_fails', R.bankPullFails)) v.bank.pullFails = true;

  // ---- New fraud archetypes ----
  const weakHealth = () => rng.normal(-1.0, 0.8);
  if (fraud === 'unsettled_sales') {
    pos = pos ?? { platform: pick(rng, PLATFORMS), days: Math.min(historyDays, rng.int(200, 400)) };
    v.inflation = rng.uniform(1.4, 2.2);
    v.burstDays = rng.int(120, 180);
    v.unseenVariant = rng.chance(0.5);
    overrides.pos = pos;
    overrides.statedMonthlyRevenueCents = roundTo(
      ctx.revenueAtApplicationCents * v.inflation,
      10_000,
    );
    overrides.requestedRentCents = roundTo(
      ctx.revenueAtApplicationCents * v.inflation * rng.uniform(0.1, 0.16),
      5000,
    );
    overrides.latentHealth = weakHealth();
  } else if (fraud === 'borrowed_account') {
    // Someone else's healthy account. The real owner pulls access, or the account is
    // emptied, weeks after the first payout.
    const other = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} Holdings LLC`;
    v.bank.ownerNames = [other];
    v.bank.accountType = 'BUSINESS';
    if (rng.chance(0.6)) {
      pos = pos ?? {
        platform: pick(rng, PLATFORMS),
        days: Math.min(historyDays, rng.int(200, 400)),
      };
      overrides.pos = pos;
    } else {
      pos = null;
      overrides.pos = null;
    }
    overrides.requestedRentCents = roundTo(ctx.rentCents * rng.lognormal(1, 0.35), 5000);
    overrides.forwardEvents = [
      { kind: 'closure', date: addDays(ctx.applicationDate, rng.int(20, 75)) },
    ];
    v.pos = pos
      ? {
          legalName: other,
          taxIdLast4: null,
          createdDaysBefore: pos.days,
          accessMethod: pos.platform === 'TOAST' ? 'DELEGATED_SEAT' : 'DIRECT_OAUTH',
          pullFails: false,
        }
      : null;
  } else if (fraud === 'fresh_pos_account') {
    v.burstDays = rng.int(30, 75);
    v.inflation = rng.uniform(1.6, 2.4);
    pos = {
      platform: pick(
        rng,
        PLATFORMS.filter((p) => p !== 'TOAST'),
      ),
      days: v.burstDays,
    };
    overrides.pos = pos;
    overrides.statedMonthlyRevenueCents = roundTo(
      ctx.revenueAtApplicationCents * v.inflation,
      10_000,
    );
    overrides.requestedRentCents = roundTo(
      ctx.revenueAtApplicationCents * v.inflation * rng.uniform(0.1, 0.16),
      5000,
    );
    overrides.latentHealth = weakHealth();
  } else if (fraud === 'hidden_accounts') {
    // Debt paid from an account that was not shared, funded by transfers from this one.
    overrides.params = { loan: rng.uniform(0.04, 0.09), mcaDaily: rng.uniform(0.04, 0.12) };
    if (rng.chance(0.5)) {
      v.bank.unshared = [
        { mask: v.hiddenMask, name: 'Operating Account', type: 'BUSINESS', shared: false },
      ];
    }
  } else if (fraud === 'rewritten_history') {
    // A struggling account whose later pull leaves out its overdraft fees and debt.
    v.priorPullDaysBefore = rng.int(5, 20);
    overrides.latentHealth = weakHealth();
    overrides.pastEvents = Array.from({ length: rng.int(3, 6) }, () => ({
      kind: 'expense' as const,
      date: addDays(ctx.applicationDate, -rng.int(15, 88)),
      shareOfMonthly: rng.uniform(0.12, 0.2),
    }));
    if (rng.chance(0.5)) overrides.params = { mcaDaily: rng.uniform(0.03, 0.08) };
  }
  if (overrides.latentHealth !== undefined && fraud !== 'borrowed_account') {
    overrides.forwardEvents = ctx.drawForwardHazards(rng, overrides.latentHealth);
  }

  // ---- The point of sale connection ----
  if (pos && !v.pos) {
    const platform = pos.platform;
    let posName: string | null = rng.chance(0.75) ? formatVariant(rng, legalName) : legalName;
    if (tag('pos_trading_name', R.posTradingName)) posName = dba ?? posName;
    else if (tag('pos_owner_name', R.posOwnerName)) posName = ownerNames[0]!;
    else if (tag('pos_other_name', R.posOtherName)) {
      // A former company name, or the parent company that holds the account.
      posName = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} Group LLC`;
    }
    let posTax: string | null = rng.chance(R.posTaxReported) ? taxIdLast4 : null;
    if (posTax && tag('pos_tax_typo', R.posTaxTypo))
      posTax = String((Number(taxIdLast4) + 1) % 10_000).padStart(4, '0');
    const accessMethod = platform === 'TOAST' ? 'DELEGATED_SEAT' : 'DIRECT_OAUTH';
    let pullFails = false;
    if (accessMethod === 'DIRECT_OAUTH' && tag('pos_token_expired', R.posTokenExpired))
      pullFails = true;
    if (accessMethod === 'DELEGATED_SEAT' && tag('seat_pull_fails', R.seatPullFails))
      pullFails = true;
    v.pos = {
      legalName: posName,
      taxIdLast4: posTax,
      createdDaysBefore: fraud === 'fresh_pos_account' ? v.burstDays : pos.days,
      accessMethod,
      pullFails,
    };
    if (honest) {
      if (pos.days < Math.min(historyDays, ctx.timeInBusinessMonths * 30) - 60)
        tags.push('platform_switch');
      if (!tag('second_payout_connected', R.secondPayoutConnected)) {
        tag('second_payout_unconnected', R.secondPayoutUnconnected);
      }
      tag('multi_location', R.multiLocation);
      tag('processor_holds', R.processorHolds);
      tag('split_deposits', R.splitDeposits);
      tag('payout_rounding', R.payoutRounding);
    }
  }
  return { veracity: v, overrides };
}

// ---------- What the connections show ----------

const dow = (date: IsoDate) => {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

/** Sum debits by the following Friday into one transfer. */
function weeklyTransfers(
  removed: readonly BankTransaction[],
  sign: 1 | -1,
  description: string,
  category: BankTransaction['category'],
  asOf: IsoDate,
  idPrefix: string,
): BankTransaction[] {
  const byFriday = new Map<IsoDate, number>();
  for (const t of removed) {
    let d = t.date;
    while (dow(d) !== 5) d = addDays(d, 1);
    if (d > asOf) d = asOf;
    byFriday.set(d, (byFriday.get(d) ?? 0) + Math.abs(t.amountCents));
  }
  return [...byFriday.entries()].map(([date, cents], i) => ({
    id: `${idPrefix}${i}`,
    date,
    amountCents: sign * cents,
    description,
    category,
    pending: false,
  }));
}

const byDate = (a: BankTransaction, b: BankTransaction) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

export interface Observed {
  /** The primary account's transactions as the decision sees them. */
  transactions: BankTransaction[];
  /** Point of sale daily sales as the platform reports them. */
  dailySales: DailySales[] | null;
  veracity: VeracityInput;
}

/**
 * What the connections show of an applicant on the application date: the simulated account
 * (`transactions`, true cash flows) and point of sale (`dailySales`) seen through each
 * connection's quirks. Pure and deterministic.
 */
export function observe(
  applicant: {
    seedHex: string;
    applicationDate: IsoDate;
    timeInBusinessMonths: number;
    pos: { platform: CommercePlatform; days: number } | null;
    veracity: ApplicantVeracity;
  },
  transactions: readonly BankTransaction[],
  dailySales: readonly DailySales[] | null,
): Observed {
  const v = applicant.veracity;
  const asOf = applicant.applicationDate;
  const rng = createRng(applicant.seedHex, 'observe');
  const tags = new Set(v.tags);
  const platform = applicant.pos?.platform ?? 'SQUARE';
  const label = COMMERCE_PLATFORM_LABELS[platform].toUpperCase();
  // Card settlements carry the processor's name: the platform's from the day its account
  // opened, the previous processor's before that.
  const posStart = applicant.pos ? addDays(asOf, -(applicant.pos.days - 1)) : null;
  let txs = posStart
    ? transactions.map((t) =>
        t.category === 'CARD_SETTLEMENT'
          ? {
              ...t,
              description: t.date >= posStart ? `${label} SETTLEMENT` : 'MERCHANT SVCS SETTLEMENT',
            }
          : t,
      )
    : [...transactions];
  // The settlement batches the platform paid: the card credits as the simulation made them.
  let settlements = txs.filter((t) => t.category === 'CARD_SETTLEMENT' && t.amountCents > 0);
  let sales = dailySales ? dailySales.map((d) => ({ ...d })) : null;
  const extraPayouts: PlatformPayout[] = [];

  if (tags.has('savings_transfers')) {
    txs = txs.map((t) =>
      t.category === 'OWNER_DRAW' && !t.description.includes('CLOSEOUT')
        ? {
            ...t,
            category: 'TRANSFER_OUT' as const,
            description: `ONLINE TRANSFER TO SAV ${v.secondMask}`,
          }
        : t,
    );
  }
  if (v.fraud === 'hidden_accounts') {
    const debt = txs.filter((t) => t.category === 'LOAN_PAYMENT' || t.category === 'MCA_PAYMENT');
    txs = [
      ...txs.filter((t) => !debt.includes(t)),
      ...weeklyTransfers(
        debt,
        -1,
        `ONLINE TRANSFER TO CHK ${v.hiddenMask}`,
        'TRANSFER_OUT',
        asOf,
        `${applicant.seedHex}-h`,
      ),
    ].sort(byDate);
  }
  if (v.fraud === 'fresh_pos_account' && sales) {
    // Fresh volume on a new account, settled to the bank and sent back out to pay for it.
    const from = addDays(asOf, -(v.burstDays - 1));
    const fake: BankTransaction[] = [];
    sales = sales
      .filter((d) => d.date >= from)
      .map((d) => {
        const extra = Math.round(d.grossCents * (v.inflation - 1));
        const card = Math.round(extra * 0.85);
        fake.push({
          id: `${applicant.seedHex}-f${d.date}`,
          date: d.date,
          amountCents: card,
          description: `${label} SETTLEMENT`,
          category: 'CARD_SETTLEMENT',
          pending: false,
        });
        return { ...d, grossCents: d.grossCents + extra };
      });
    const out = weeklyTransfers(
      fake.map((t) => ({ ...t, date: addDays(t.date, 2) })),
      -1,
      'ONLINE TRANSFER TO CARD PMT',
      'TRANSFER_OUT',
      asOf,
      `${applicant.seedHex}-g`,
    );
    txs = [...txs, ...fake, ...out].sort(byDate);
    settlements = [...settlements, ...fake].sort(byDate);
  }
  if (v.fraud === 'unsettled_sales' && sales) {
    const from = addDays(asOf, -(v.burstDays - 1));
    sales = sales.map((d) => {
      if (d.date < from) return d;
      const extra = Math.round(d.grossCents * (v.inflation - 1));
      if (v.unseenVariant) {
        extraPayouts.push({
          id: `x${d.date}`,
          date: addDays(d.date, 1),
          amountCents: Math.round(extra * (d.cardShareBps / 10_000) * 0.971),
          destinationMask: v.secondMask,
          destinationRef: null,
          locationId: null,
        });
      }
      return { ...d, grossCents: d.grossCents + extra };
    });
  }
  if (tags.has('split_deposits')) {
    const out: BankTransaction[] = [];
    for (const t of txs) {
      if (t.category === 'CARD_SETTLEMENT' && t.amountCents > 2000 && rng.chance(0.1)) {
        const part = Math.round(t.amountCents * rng.uniform(0.3, 0.7));
        out.push(
          { ...t, id: `${t.id}a`, amountCents: part },
          { ...t, id: `${t.id}b`, amountCents: t.amountCents - part },
        );
      } else out.push(t);
    }
    txs = out;
  }
  if (tags.has('second_payout_unconnected')) {
    const swept = txs.filter((t) => t.category === 'CARD_SETTLEMENT');
    txs = [
      ...txs.filter((t) => t.category !== 'CARD_SETTLEMENT'),
      ...weeklyTransfers(
        swept,
        1,
        `ONLINE TRANSFER FROM CHK ${v.secondMask}`,
        'TRANSFER_IN',
        asOf,
        `${applicant.seedHex}-s`,
      ),
    ].sort(byDate);
  }

  // Payouts, as the platform reports them.
  const destination =
    tags.has('second_payout_connected') || tags.has('second_payout_unconnected')
      ? v.secondMask
      : v.bank.mask;
  let payouts: PlatformPayout[] = [];
  settlements.forEach((t, i) => {
    let amount = t.amountCents;
    if (tags.has('payout_rounding') && rng.chance(0.3)) amount += rng.int(-60, 60);
    const held = tags.has('processor_holds') && rng.chance(0.1) ? rng.int(1, 3) : 0;
    const date = addDays(t.date, -held);
    if (tags.has('multi_location')) {
      const first = Math.round(amount * rng.uniform(0.3, 0.7));
      payouts.push(
        {
          id: `p${i}a`,
          date,
          amountCents: first,
          destinationMask: destination,
          destinationRef: null,
          locationId: 'L1',
        },
        {
          id: `p${i}b`,
          date,
          amountCents: amount - first,
          destinationMask: destination,
          destinationRef: null,
          locationId: 'L2',
        },
      );
    } else {
      payouts.push({
        id: `p${i}`,
        date,
        amountCents: amount,
        destinationMask: destination,
        destinationRef: null,
        locationId: null,
      });
    }
  });
  const posFrom = applicant.pos ? addDays(asOf, -(applicant.pos.days - 1)) : asOf;
  payouts = [...payouts.filter((p) => p.date >= posFrom), ...extraPayouts].sort((a, b) =>
    a.date < b.date ? -1 : 1,
  );

  // The pulls: the one the decision reads, and an earlier one.
  const priorOn = v.priorPullDaysBefore > 0 ? addDays(asOf, -v.priorPullDaysBefore) : null;
  let current = txs;
  let prior = priorOn ? txs.filter((t) => t.date <= priorOn) : null;
  if (prior && priorOn && tags.has('late_posting')) {
    // The last days of the earlier pull settled at slightly different amounts.
    const edge = addDays(priorOn, -4);
    prior = prior.map((t) =>
      t.date > edge && rng.chance(0.3)
        ? { ...t, amountCents: Math.round(t.amountCents * rng.uniform(0.97, 1.03)) }
        : t,
    );
  }
  if (prior && priorOn && tags.has('resync_minor')) {
    const old = prior.filter((t) => t.date < addDays(priorOn, -10));
    const changed = new Set(
      Array.from({ length: rng.int(1, 2) }, () => old[rng.int(0, old.length - 1)]?.id),
    );
    current = current.map((t) =>
      changed.has(t.id) ? { ...t, amountCents: t.amountCents + rng.int(-500, 500) || 1 } : t,
    );
  }
  if (prior && priorOn && tags.has('resync_duplicates')) {
    const old = prior.filter((t) => t.date < addDays(priorOn, -10));
    const dupes = Array.from({ length: rng.int(3, 5) }, (_, k) => ({
      ...old[rng.int(0, old.length - 1)]!,
      id: `dup${k}`,
    }));
    current = [...current, ...dupes].sort(byDate);
  }
  if (v.fraud === 'rewritten_history' && priorOn) {
    const final = addDays(asOf, -10);
    current = current.filter(
      (t) =>
        !(
          t.date <= final &&
          (t.category === 'NSF_FEE' ||
            t.category === 'OTHER_EXPENSE' ||
            t.category === 'MCA_PAYMENT' ||
            t.category === 'LOAN_PAYMENT')
        ),
    );
  }

  const window = (on: IsoDate) => ({ windowFrom: addDays(on, -399), windowTo: on });
  const banks: BankSourceFacts[] = [
    {
      connectionId: null,
      primary: true,
      institutionName: 'Sim Bank',
      accountMask: v.bank.mask,
      institutionAuthorized: v.bank.institutionAuthorized,
      ownerNames: v.bank.ownerNames,
      accountType: v.bank.accountType,
      openedOn: addDays(asOf, -v.bank.openedDaysBefore),
      visibleAccounts: [
        { mask: v.bank.mask, name: 'Business Checking', type: v.bank.accountType, shared: true },
        ...v.bank.unshared,
      ],
      health: v.bank.pullFails ? 'ERROR' : 'HEALTHY',
      current: v.bank.pullFails
        ? null
        : {
            snapshotId: null,
            contentHash: null,
            pulledAt: `${asOf}T12:00:00.000Z`,
            pulledOn: asOf,
            ...window(asOf),
            transactions: current,
          },
      prior:
        prior && priorOn
          ? [
              {
                snapshotId: null,
                contentHash: null,
                pulledAt: `${priorOn}T12:00:00.000Z`,
                pulledOn: priorOn,
                ...window(priorOn),
                transactions: prior,
              },
            ]
          : [],
      pullError: v.bank.pullFails ? 'Connection error at decision time' : null,
    },
  ];
  if (tags.has('second_payout_connected')) {
    banks.push({
      ...banks[0]!,
      primary: false,
      accountMask: v.secondMask,
      visibleAccounts: [],
      current: { ...banks[0]!.current!, transactions: [] },
      prior: [],
    });
  }
  const commerce: CommerceSourceFacts[] = [];
  if (applicant.pos && v.pos && sales) {
    commerce.push({
      connectionId: null,
      primary: true,
      platform: applicant.pos.platform,
      accessMethod: v.pos.accessMethod,
      legalName: v.pos.legalName,
      taxIdLast4: v.pos.taxIdLast4,
      accountCreatedOn: addDays(asOf, -v.pos.createdDaysBefore),
      payoutDestinations: [{ institutionName: null, mask: destination, ref: null }],
      health: v.pos.pullFails ? 'REAUTH_REQUIRED' : 'HEALTHY',
      current: v.pos.pullFails
        ? null
        : {
            snapshotId: null,
            contentHash: null,
            pulledAt: `${asOf}T12:00:00.000Z`,
            pulledOn: asOf,
            ...window(asOf),
            dailySales: sales,
            payouts,
          },
      prior: [],
      pullError: v.pos.pullFails ? 'Token expired and could not be refreshed' : null,
    });
  }
  return {
    transactions: current,
    dailySales: sales,
    veracity: {
      asOf,
      applicant: {
        legalName: v.legalName,
        dba: v.dba,
        taxIdLast4: v.taxIdLast4,
        ownerNames: v.ownerNames,
        timeInBusinessMonths: applicant.timeInBusinessMonths,
      },
      banks,
      commerce,
    },
  };
}

export { clamp };
