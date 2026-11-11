import { addDays } from '@cashflow/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { clockNow, devClockAhead, effectiveAt, setDevClockDate, todayIso } from './dates.ts';

const wall = () => new Date().toISOString().slice(0, 10);

afterEach(() => setDevClockDate(null));

describe('the clock with dev tools off', () => {
  it('reads the wall clock', () => {
    expect(devClockAhead()).toBeNull();
    expect(todayIso()).toBe(wall());
    expect(Math.abs(clockNow().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('stamps today with the current instant and a past date with its midday', () => {
    expect(Math.abs(effectiveAt(wall()).getTime() - Date.now())).toBeLessThan(1000);
    expect(effectiveAt('2020-02-03').toISOString()).toBe('2020-02-03T12:00:00.000Z');
  });
});

describe('the dev clock', () => {
  it('pins today to a simulated date that is ahead', () => {
    const target = addDays(wall(), 9);
    setDevClockDate(target);
    expect(devClockAhead()).toBe(target);
    expect(todayIso()).toBe(target);
    // The same time of day, nine days on.
    expect(Math.abs(clockNow().getTime() - (Date.now() + 9 * 86_400_000))).toBeLessThan(1000);
    expect(clockNow().toISOString().slice(0, 10)).toBe(target);
  });

  it('makes the simulated date the one that is stamped with the current instant', () => {
    const target = addDays(wall(), 3);
    setDevClockDate(target);
    expect(effectiveAt(target).toISOString().slice(0, 10)).toBe(target);
    expect(effectiveAt(target).toISOString()).not.toBe(`${target}T12:00:00.000Z`);
    // The real date is now a past date like any other.
    expect(effectiveAt(wall()).toISOString()).toBe(`${wall()}T12:00:00.000Z`);
  });

  it('never runs behind the wall clock', () => {
    setDevClockDate(addDays(wall(), -5));
    expect(devClockAhead()).toBeNull();
    expect(todayIso()).toBe(wall());
    setDevClockDate(wall());
    expect(devClockAhead()).toBeNull();
  });

  it('still reads an explicit instant as given', () => {
    setDevClockDate(addDays(wall(), 30));
    expect(todayIso(new Date('2024-05-06T23:59:59Z'))).toBe('2024-05-06');
  });

  it('goes back to the wall clock when cleared', () => {
    setDevClockDate(addDays(wall(), 30));
    setDevClockDate(null);
    expect(todayIso()).toBe(wall());
  });
});
