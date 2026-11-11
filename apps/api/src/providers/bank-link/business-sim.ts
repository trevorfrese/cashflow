import type { BankTransaction, IsoDate, TransactionCategory } from '@cashflow/shared';
import { daysBetween, daysInMonth, parseIsoDate, toIsoDate } from '@cashflow/shared';

/**
 * Day stepping core for synthetic business bank accounts.
 *
 * One `BusinessSimulation` walks a single business forward one day at a time from a fixed
 * start date. It is driven two ways:
 *
 *   - `generateHistory` in `synthetic.ts` runs it over a window that ends at the as-of date,
 *     with the named sandbox scenarios. Output for existing tokens is pinned by
 *     `providers/synthetic-pin.test.ts`.
 *   - `simulateBusiness` below (and the portfolio evals) run it forward from a start date with
 *     continuous parameters, hazard events, and externally supplied debits. Because each day
 *     depends only on the state carried from the day before, the history up to any date is a
 *     true prefix of a longer run.
 *
 * Everything is deterministic: the only randomness is the seeded generator passed in.
 */

/** Continuous description of one business. Ratios are fractions of monthly revenue. */
export interface BusinessParams {
  /** Monthly revenue at the reference level (trend, season, and noise multiply it). */
  monthlyRevenueCents: number;
  /** Rent the business pays its landlord on the first of the month. */
  rentCents: number;
  /** Seasonal amplitude, as a fraction of revenue. */
  seasonality: number;
  /** Day to day noise on sales (log scale sigma). */
  dailyNoise: number;
  /** Month to month noise on the revenue level. */
  monthlyNoise: number;
  payroll: number;
  supplier: number;
  utilities: number;
  insurance: number;
  software: number;
  taxQuarterly: number;
  ownerDraw: number;
  loan: number;
  mcaDaily: number;
  /** Opening balance in months of revenue. */
  openingBalanceMonths: number;
  /** Card sales settle every other week instead of daily. */
  batchedSettlement?: boolean;
}

/** Things that happen to a business on known dates. They consume no randomness. */
export type HazardEvent =
  /** Revenue drops by `depth` (0..1) for `days` days, then recovers. */
  | { kind: 'revenue_shock'; start: IsoDate; days: number; depth: number }
  /** Revenue slides down linearly to `1 - depth` over `rampDays` and stays there. */
  | { kind: 'decline'; start: IsoDate; rampDays: number; depth: number }
  /** The business shuts for good. The owner empties the account and nothing moves after. */
  | { kind: 'closure'; date: IsoDate }
  /** One unplanned large debit, as a share of that month's revenue. */
  | { kind: 'expense'; date: IsoDate; shareOfMonthly: number }
  /**
   * Round tripped deposits: each week a credit that looks like revenue lands and the same
   * amount leaves two days later as a transfer out. Used to model inflated bank revenue.
   */
  | { kind: 'round_trip'; start: IsoDate; days: number; weeklyCents: number };

export interface SimulationOptions {
  params: BusinessParams;
  /** Prefix for transaction ids. */
  seedHex: string;
  start: IsoDate;
  rand: () => number;
  /** Revenue trend multiplier for day index `i` (0 is the start date). */
  trendFactor: (dayIndex: number) => number;
  events?: readonly HazardEvent[];
  /**
   * Share of a revenue drop that costs follow. 1 means costs flex fully with revenue (the
   * sandbox scenarios behave this way); 0 means costs are fixed when revenue falls.
   */
  costFlex?: number;
  /** Personal funds the owner can move in to cover shortfalls. Infinity for the sandbox. */
  ownerReserveCents?: number;
  /**
   * How far the bank lets the account overdraw before it returns the business's own debits.
   * Infinity for the sandbox, where every debit posts.
   */
  overdraftLimitCents?: number;
  /** Keep transactions. Turn off to step forward cheaply once the history is no longer needed. */
  record?: boolean;
}

export interface ExternalDebit {
  amountCents: number;
  description: string;
}

export const NSF_FEE_CENTS = 3500;

/** Small deterministic PRNG so every seed yields the same history. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Sales mix by weekday, closed Mondays. Normalized so a week sums to the weekly target.
export const WEEKDAY_WEIGHT = [1.1, 0, 0.8, 0.8, 0.9, 1.4, 1.5];
export const WEEK_WEIGHT_SUM = WEEKDAY_WEIGHT.reduce((a, b) => a + b, 0);

interface CompiledEvent {
  kind: HazardEvent['kind'];
  from: number;
  to: number;
  value: number;
}

const NO_RESULTS: readonly boolean[] = [];

export class BusinessSimulation {
  /** Index of the next day to simulate. 0 is the start date. */
  dayIndex = 0;
  balanceCents: number;
  /** Set once the business has shut, by a closure event or by running out of money. */
  closed = false;
  closedOn: IsoDate | null = null;
  /** Gross sales on the day most recently simulated, before the card and cash split. */
  lastSalesCents = 0;
  transactions: BankTransaction[] = [];
  record: boolean;

  private readonly p: BusinessParams;
  private readonly seedHex: string;
  private readonly rand: () => number;
  private readonly trendFactor: (dayIndex: number) => number;
  private readonly events: CompiledEvent[];
  private readonly revenueEvents: CompiledEvent[];
  private readonly costFlex: number;
  private readonly overdraftLimitCents: number;
  private readonly weeklyRevenue: number;
  private ownerReserveCents: number;
  private externalRentCents = 0;

  // Calendar cursor for the next day to simulate.
  private year: number;
  private month: number;
  private day: number;
  private dow: number;
  private doy: number;
  private dateCache: IsoDate | null = null;

  private n = 0;
  private negativeStreak = 0;
  private monthLevel = 1;
  private currentMonth = 0;
  private pendingSettlement = 0;
  private nsfChargedToday = false;
  private missedPayrolls = 0;
  private missedRents = 0;

  constructor(options: SimulationOptions) {
    this.p = options.params;
    this.seedHex = options.seedHex;
    this.rand = options.rand;
    this.trendFactor = options.trendFactor;
    this.costFlex = options.costFlex ?? 1;
    this.ownerReserveCents = options.ownerReserveCents ?? Infinity;
    this.overdraftLimitCents = options.overdraftLimitCents ?? Infinity;
    this.record = options.record ?? true;
    this.weeklyRevenue = (this.p.monthlyRevenueCents * 12) / 52;
    this.balanceCents = Math.round(this.p.monthlyRevenueCents * this.p.openingBalanceMonths);

    const { year, month, day } = parseIsoDate(options.start);
    this.year = year;
    this.month = month;
    this.day = day;
    this.dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    this.doy = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000);

    this.events = (options.events ?? []).map((e): CompiledEvent => {
      switch (e.kind) {
        case 'revenue_shock': {
          const from = daysBetween(options.start, e.start);
          return { kind: e.kind, from, to: from + e.days, value: e.depth };
        }
        case 'decline': {
          const from = daysBetween(options.start, e.start);
          return { kind: e.kind, from, to: from + Math.max(1, e.rampDays), value: e.depth };
        }
        case 'closure': {
          const from = daysBetween(options.start, e.date);
          return { kind: e.kind, from, to: from, value: 0 };
        }
        case 'expense': {
          const from = daysBetween(options.start, e.date);
          return { kind: e.kind, from, to: from, value: e.shareOfMonthly };
        }
        case 'round_trip': {
          const from = daysBetween(options.start, e.start);
          return { kind: e.kind, from, to: from + e.days, value: e.weeklyCents };
        }
      }
    });
    this.revenueEvents = this.events.filter(
      (e) => e.kind === 'revenue_shock' || e.kind === 'decline',
    );
  }

  /** The date of the next day to simulate. */
  get date(): IsoDate {
    this.dateCache ??= toIsoDate(this.year, this.month, this.day);
    return this.dateCache;
  }

  /**
   * From the next rent date on, this much of the monthly rent is paid by someone else (a
   * CashFlow plan), so the business's own rent debit shrinks by that amount.
   */
  setExternalRent(cents: number): void {
    this.externalRentCents = Math.max(0, cents);
  }

  /** Remaining multiplier on revenue from shocks and declines on day `i`. */
  private revenueFactor(i: number): number {
    let f = 1;
    for (const e of this.revenueEvents) {
      if (i < e.from) continue;
      if (e.kind === 'revenue_shock') {
        if (i < e.to) f *= 1 - e.value;
      } else {
        f *= 1 - e.value * Math.min(1, (i - e.from) / (e.to - e.from));
      }
    }
    return f;
  }

  private push(amountCents: number, description: string, category: TransactionCategory): void {
    if (amountCents === 0) return;
    this.n += 1;
    if (!this.record) return;
    this.transactions.push({
      id: `${this.seedHex}-${this.n}`,
      date: this.date,
      amountCents,
      description,
      category,
      pending: false,
    });
  }

  private chargeNsf(): void {
    if (this.nsfChargedToday) return;
    // A bank stops piling fees on an account that is already far under water.
    if (this.balanceCents < -(this.overdraftLimitCents + 10 * NSF_FEE_CENTS)) return;
    this.push(-NSF_FEE_CENTS, 'NSF FEE', 'NSF_FEE');
    this.balanceCents -= NSF_FEE_CENTS;
    this.nsfChargedToday = true;
  }

  /**
   * One of the business's own debits. It posts and may overdraw the account, drawing one NSF
   * fee for the day. Past the overdraft limit the bank returns it instead. Returns whether
   * it posted.
   */
  private debit(amount: number, description: string, category: TransactionCategory): boolean {
    const cents = -Math.round(amount);
    if (cents === 0) return true;
    if (this.balanceCents + cents < -this.overdraftLimitCents) {
      this.chargeNsf();
      return false;
    }
    this.push(cents, description, category);
    this.balanceCents += cents;
    if (this.balanceCents < 0) this.chargeNsf();
    return true;
  }

  private close(): void {
    this.closed = true;
    this.closedOn = this.date;
    if (this.balanceCents > 0) {
      this.push(-this.balanceCents, 'OWNER DRAW - ACCOUNT CLOSEOUT', 'OWNER_DRAW');
      this.balanceCents = 0;
    }
  }

  private advance(): void {
    this.dayIndex += 1;
    this.dateCache = null;
    this.dow = (this.dow + 1) % 7;
    this.day += 1;
    this.doy += 1;
    if (this.day > daysInMonth(this.year, this.month)) {
      this.day = 1;
      this.month += 1;
      if (this.month > 12) {
        this.month = 1;
        this.year += 1;
        this.doy = 0;
      }
    }
  }

  /**
   * Simulate one day. `external` debits (installment collections) are attempted after the
   * day's deposits and before the business's own bills. Each succeeds only if the balance at
   * that moment covers it in full: an outside creditor gets no overdraft. Returns one flag per
   * external debit.
   */
  step(external?: readonly ExternalDebit[]): readonly boolean[] {
    const p = this.p;
    const i = this.dayIndex;
    const { day, month, dow } = this;
    this.nsfChargedToday = false;
    this.lastSalesCents = 0;

    for (const e of this.events) {
      if (e.kind === 'closure' && e.from <= i && !this.closed) this.close();
    }

    if (this.closed) {
      const results = external ? external.map(() => false) : NO_RESULTS;
      this.advance();
      return results;
    }

    const monthKey = this.year * 12 + month;
    if (monthKey !== this.currentMonth) {
      this.currentMonth = monthKey;
      this.monthLevel = Math.exp(normal(this.rand) * p.monthlyNoise);
    }
    const seasonFactor = 1 + p.seasonality * Math.sin(((this.doy - 105) / 365) * 2 * Math.PI);
    const baseLevel = this.trendFactor(i) * seasonFactor * this.monthLevel;
    const revenueFactor = this.revenueEvents.length > 0 ? this.revenueFactor(i) : 1;
    const level = baseLevel * revenueFactor;
    // Costs follow revenue down only as far as `costFlex` allows.
    const monthly = p.monthlyRevenueCents * (baseLevel * (1 - this.costFlex * (1 - revenueFactor)));

    // Inflows
    const dayShare = WEEKDAY_WEIGHT[dow]! / WEEK_WEIGHT_SUM;
    if (dayShare > 0) {
      const sales =
        this.weeklyRevenue * level * dayShare * Math.exp(normal(this.rand) * p.dailyNoise);
      this.lastSalesCents = Math.round(sales);
      if (p.batchedSettlement) {
        this.pendingSettlement += Math.round(sales * 0.85);
      } else {
        this.push(Math.round(sales * 0.85), 'SQUARE INC SETTLEMENT', 'CARD_SETTLEMENT');
        this.balanceCents += Math.round(sales * 0.85);
      }
      if (dow === 2) {
        const cash = Math.round(this.weeklyRevenue * level * 0.15);
        this.push(cash, 'CASH DEPOSIT BRANCH 0142', 'CASH_DEPOSIT');
        this.balanceCents += cash;
      }
    }

    if (
      p.batchedSettlement &&
      dow === 4 &&
      Math.floor(i / 7) % 2 === 1 &&
      this.pendingSettlement > 0
    ) {
      this.push(this.pendingSettlement, 'SQUARE INC BIWEEKLY SETTLEMENT', 'CARD_SETTLEMENT');
      this.balanceCents += this.pendingSettlement;
      this.pendingSettlement = 0;
    }

    for (const e of this.events) {
      if (e.kind !== 'round_trip' || i < e.from || i >= e.to) continue;
      if (dow === 3) {
        this.push(e.value, 'ACH CREDIT - CLIENT PAYMENT', 'INVOICE_PAYMENT');
        this.balanceCents += e.value;
      } else if (dow === 5) {
        this.push(-e.value, 'ONLINE TRANSFER TO SAV 4471', 'TRANSFER_OUT');
        this.balanceCents -= e.value;
      }
    }

    // Outside debits. No overdraft: the bank returns the debit when the balance is short.
    let results: readonly boolean[] = NO_RESULTS;
    let externalShortfall = 0;
    if (external && external.length > 0) {
      const flags: boolean[] = [];
      for (const d of external) {
        if (d.amountCents <= this.balanceCents) {
          this.push(-d.amountCents, d.description, 'RENT');
          this.balanceCents -= d.amountCents;
          flags.push(true);
        } else {
          externalShortfall += d.amountCents;
          this.chargeNsf();
          flags.push(false);
        }
      }
      results = flags;
    }

    // The business's own outflows. A debit that overdraws the account draws one NSF fee for
    // the day.
    if (dow === 5 && Math.floor(i / 7) % 2 === 0) {
      const paid = this.debit(((monthly * p.payroll) / 26) * 12, 'GUSTO PAYROLL', 'PAYROLL');
      this.missedPayrolls = paid ? 0 : this.missedPayrolls + 1;
    }
    if (day === 1) {
      const paid = this.debit(
        p.rentCents - Math.min(p.rentCents, this.externalRentCents),
        'RENT - HARBOR VIEW PROPERTIES',
        'RENT',
      );
      this.missedRents = paid ? 0 : this.missedRents + 1;
    }
    if (dow === 1 || dow === 3 || dow === 5) {
      this.debit(
        ((monthly * p.supplier) / 13) * Math.exp(normal(this.rand) * 0.2),
        dow === 3 ? 'SYSCO FOODS' : 'RESTAURANT DEPOT',
        'SUPPLIER',
      );
    }
    if (day === 10) this.debit(monthly * p.utilities, 'CITY POWER & GAS', 'UTILITIES');
    if (day === 15) this.debit(monthly * p.insurance, 'HARTFORD BUSINESS INS', 'INSURANCE');
    if (day === 5) this.debit(monthly * p.software, 'TOAST POS SUBSCRIPTION', 'SOFTWARE');
    if (day === 28) this.debit(2500, 'MONTHLY SERVICE FEE', 'BANK_FEE');
    if (day === 15 && (month === 1 || month === 4 || month === 6 || month === 9)) {
      this.debit(monthly * p.taxQuarterly * 3, 'IRS EFTPS PAYMENT', 'TAX');
    }
    if (day === 20) this.debit(monthly * p.ownerDraw, 'OWNER DRAW - TRANSFER', 'OWNER_DRAW');
    if (day === 3 && p.loan > 0) this.debit(monthly * p.loan, 'LOAN PMT - SBA 7A', 'LOAN_PAYMENT');
    if (p.mcaDaily > 0 && dow >= 1 && dow <= 5) {
      this.debit((monthly * p.mcaDaily) / 22, 'MCA DAILY ACH - RAPID FUNDING', 'MCA_PAYMENT');
    }
    if (dow === 4 && this.rand() < 0.5) {
      this.debit(monthly * 0.004 * this.rand(), 'REFUND - CUSTOMER', 'REFUND');
    }
    for (const e of this.events) {
      if (e.kind === 'expense' && e.from === i) {
        this.debit(monthly * e.value, 'EQUIPMENT REPAIR - ACE HVAC', 'OTHER_EXPENSE');
      }
    }

    // Owners do not leave an account overdrawn for long. After two negative days the owner
    // moves money in from personal savings, which is why conduct problems show up as a
    // pattern of fees and short negative stretches rather than a permanently negative balance.
    // The same owner covers a returned installment the next morning. Both stop when the
    // owner's reserve runs out.
    if (externalShortfall > 0 && this.ownerReserveCents > 0) {
      const want = externalShortfall - this.balanceCents + Math.round(monthly * 0.03);
      const topUp = Math.min(want, this.ownerReserveCents);
      if (topUp > 0) {
        this.push(topUp, 'OWNER CAPITAL CONTRIBUTION', 'TRANSFER_IN');
        this.balanceCents += topUp;
        this.ownerReserveCents -= topUp;
      }
    }
    if (this.balanceCents < 0) {
      this.negativeStreak += 1;
      if (this.negativeStreak >= 2 && this.ownerReserveCents > 0) {
        const topUp = Math.min(
          -this.balanceCents + Math.round(monthly * 0.03),
          this.ownerReserveCents,
        );
        this.push(topUp, 'OWNER CAPITAL CONTRIBUTION', 'TRANSFER_IN');
        this.balanceCents += topUp;
        this.ownerReserveCents -= topUp;
        this.negativeStreak = 0;
      }
    } else {
      this.negativeStreak = 0;
    }

    // Two payrolls or two rents returned in a row and the business does not reopen.
    if (this.missedPayrolls >= 2 || this.missedRents >= 2) this.close();

    this.advance();
    return results;
  }
}

/** Parameters for a forward run: a business plus how it behaves under pressure. */
export interface ForwardParams extends BusinessParams {
  /** Revenue growth per year, compounding from the start date. 0.06 is 6% a year. */
  annualGrowth: number;
  costFlex: number;
  ownerReserveCents: number;
  overdraftLimitCents: number;
  events: readonly HazardEvent[];
}

export function seedFromHex(seedHex: string): number {
  return parseInt(seedHex.slice(0, 8), 16) || 1;
}

/** Build the stepping simulation for a forward run. The portfolio evals drive this directly. */
export function createForwardSimulation(
  params: ForwardParams,
  seedHex: string,
  start: IsoDate,
): BusinessSimulation {
  const logGrowth = Math.log(1 + params.annualGrowth);
  return new BusinessSimulation({
    params,
    seedHex,
    start,
    rand: mulberry32(seedFromHex(seedHex)),
    trendFactor: (i) => Math.exp((logGrowth * i) / 365),
    events: params.events,
    costFlex: params.costFlex,
    ownerReserveCents: params.ownerReserveCents,
    overdraftLimitCents: params.overdraftLimitCents,
  });
}

export interface SimulateHooks {
  /**
   * From this date on, `externalRentCents` of the monthly rent (all of it by default) is no
   * longer debited by the landlord. Supply the replacement debits through `externalDebits`.
   */
  rentExternalFrom?: IsoDate;
  externalRentCents?: number;
  /** Debits to attempt on `date`, given the balance at the start of that day. */
  externalDebits?: (date: IsoDate, balanceCents: number) => ExternalDebit[];
  /** Called once per external debit with whether it cleared. */
  onDebitResult?: (date: IsoDate, debit: ExternalDebit, ok: boolean) => void;
}

export interface SimulatedBusiness {
  transactions: BankTransaction[];
  endingBalanceCents: number;
  /** Balance at the end of each simulated day, oldest first. */
  dailyBalancesCents: number[];
  /** Gross sales per open day: the path a point of sale would report. */
  dailySales: { date: IsoDate; grossCents: number }[];
  closedOn: IsoDate | null;
}

/**
 * Walk a business forward `days` days from `start`. Running it for fewer days yields an exact
 * prefix of a longer run with the same arguments, which is what lets an underwriting decision
 * read the first part and a portfolio simulation play out the rest.
 */
export function simulateBusiness(
  params: ForwardParams,
  seedHex: string,
  start: IsoDate,
  days: number,
  hooks: SimulateHooks = {},
): SimulatedBusiness {
  const sim = createForwardSimulation(params, seedHex, start);
  const dailyBalancesCents: number[] = [];
  const dailySales: { date: IsoDate; grossCents: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = sim.date;
    if (hooks.rentExternalFrom !== undefined && date >= hooks.rentExternalFrom) {
      sim.setExternalRent(hooks.externalRentCents ?? params.rentCents);
    }
    const debits = hooks.externalDebits?.(date, sim.balanceCents) ?? [];
    const results = sim.step(debits);
    debits.forEach((d, k) => hooks.onDebitResult?.(date, d, results[k]!));
    dailyBalancesCents.push(sim.balanceCents);
    if (sim.lastSalesCents > 0) dailySales.push({ date, grossCents: sim.lastSalesCents });
  }
  return {
    transactions: sim.transactions,
    endingBalanceCents: sim.balanceCents,
    dailyBalancesCents,
    dailySales,
    closedOn: sim.closedOn,
  };
}
