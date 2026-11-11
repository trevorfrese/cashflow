import { describe, expect, it } from 'vitest';

import { createForwardSimulation } from '../providers/bank-link/business-sim.ts';
import { addDays } from '@cashflow/shared';
import { drawPopulation, ORIGINAL_FRAUD_TYPES } from './population.ts';
import { NEW_FRAUD_TYPES } from './veracity-sim.ts';

describe('population', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = drawPopulation({ n: 150, seed: 'pop' });
    const b = drawPopulation({ n: 150, seed: 'pop' });
    const c = drawPopulation({ n: 150, seed: 'other' });
    expect(b).toEqual(a);
    expect(c.map((x) => x.params.monthlyRevenueCents)).not.toEqual(
      a.map((x) => x.params.monthlyRevenueCents),
    );
  });

  it('keeps the same businesses when the population grows', () => {
    const small = drawPopulation({ n: 50, seed: 'pop' });
    const large = drawPopulation({ n: 120, seed: 'pop' });
    const byId = new Map(large.map((a) => [a.id, a]));
    for (const a of small) expect(byId.get(a.id)).toEqual(a);
  });

  it('draws plausible, well formed applicants sorted by application date', () => {
    const pop = drawPopulation({ n: 400, seed: 'pop' });
    expect(pop).toHaveLength(400);
    for (let i = 1; i < pop.length; i++) {
      expect(pop[i]!.applicationDate >= pop[i - 1]!.applicationDate).toBe(true);
    }
    for (const a of pop) {
      expect(Number.isInteger(a.statedMonthlyRevenueCents)).toBe(true);
      expect(Number.isInteger(a.requestedRentCents)).toBe(true);
      expect(Number.isInteger(a.params.monthlyRevenueCents)).toBe(true);
      expect(a.requestedRentCents).toBeGreaterThan(0);
      expect(a.applicationDate >= '2026-01-01' && a.applicationDate <= '2026-12-28').toBe(true);
      expect(a.params.payroll + a.params.supplier).toBeGreaterThan(0.29);
      if (a.pos) expect(a.pos.days).toBeLessThanOrEqual(a.historyDays);
    }
    // More applications arrive late in the window than early.
    const firstHalf = pop.filter((a) => a.arrivalMonth < 6).length;
    expect(pop.length - firstHalf).toBeGreaterThan(firstHalf);
    // Some honest applicants ask for a lot relative to revenue.
    expect(
      pop.some((a) => !a.fraud && a.requestedRentCents > a.statedMonthlyRevenueCents * 0.25),
    ).toBe(true);
  });

  it('honors the fraud share and gives each fraud type its tell', () => {
    const pop = drawPopulation({ n: 400, seed: 'pop', fraudShareBps: 3000 });
    const fraud = pop.filter(
      (a) => a.fraud !== null && (ORIGINAL_FRAUD_TYPES as readonly string[]).includes(a.fraud),
    );
    expect(fraud.length).toBeGreaterThan(80);
    expect(fraud.length).toBeLessThan(160);
    expect(new Set(fraud.map((a) => a.fraud))).toEqual(new Set(ORIGINAL_FRAUD_TYPES));
    for (const a of fraud) {
      expect(a.segment).toBe(a.fraud);
      expect(a.pos).toBeNull();
      if (a.fraud === 'bust_out') {
        expect(a.requestedRentCents).toBeGreaterThan(a.params.rentCents);
        const closure = a.params.events.find((e) => e.kind === 'closure');
        expect(closure?.kind === 'closure' && closure.date > a.applicationDate).toBe(true);
      }
      if (a.fraud === 'round_trip') {
        expect(a.params.events.some((e) => e.kind === 'round_trip')).toBe(true);
      }
    }
    expect(
      drawPopulation({ n: 200, seed: 'pop', fraudShareBps: 0 }).some(
        (a) => a.fraud !== null && (ORIGINAL_FRAUD_TYPES as readonly string[]).includes(a.fraud),
      ),
    ).toBe(false);
  });

  it('draws the veracity fraud archetypes from honest applicants, each with its tell', () => {
    const pop = drawPopulation({ n: 1500, seed: 'veracity' });
    const fresh = pop.filter(
      (a) => a.fraud !== null && (NEW_FRAUD_TYPES as readonly string[]).includes(a.fraud),
    );
    // 2.5% of applicants, give or take sampling.
    expect(fresh.length).toBeGreaterThan(15);
    expect(fresh.length).toBeLessThan(65);
    expect(new Set(fresh.map((a) => a.fraud))).toEqual(new Set(NEW_FRAUD_TYPES));
    for (const a of fresh) {
      const v = a.veracity!;
      expect(v.fraud).toBe(a.fraud);
      expect(v.tags).toEqual([]);
      if (a.fraud === 'unsettled_sales') expect(a.pos).not.toBeNull();
      if (a.fraud === 'borrowed_account') expect(v.bank.ownerNames[0]).toMatch(/Holdings LLC$/);
      if (a.fraud === 'fresh_pos_account') expect(a.pos!.days).toBe(v.burstDays);
      if (a.fraud === 'rewritten_history') expect(v.priorPullDaysBefore).toBeGreaterThan(0);
    }
    // Honest applicants carry their messiness as tags.
    const honest = pop.filter((a) => a.fraud === null);
    expect(honest.filter((a) => a.veracity!.tags.includes('legacy_bank')).length).toBeGreaterThan(
      200,
    );
  });

  it('only contains businesses that are still trading when they apply', () => {
    for (const a of drawPopulation({ n: 200, seed: 'alive' })) {
      if (a.historyDays === 0) continue;
      const sim = createForwardSimulation(
        a.params,
        a.seedHex,
        addDays(a.applicationDate, -(a.historyDays - 1)),
      );
      sim.record = false;
      for (let i = 0; i < a.historyDays; i++) sim.step();
      expect(sim.closed).toBe(false);
    }
  });
});
