import { describe, expect, it } from 'vitest';

import {
  decodeCommerceItemId,
  encodeCommerceItemId,
  generateSales,
  generateSalesAt,
  parseCommerceScenario,
} from './synthetic.ts';

const AS_OF = '2026-11-09';

describe('synthetic platform sales', () => {
  it('reads the scenario, the sales level, and a platform keyword from the token', () => {
    const spec = parseCommerceScenario('toast_declining_sales_25000', 'SQUARE');
    expect(spec).toMatchObject({
      scenario: 'declining',
      monthlyRevenueCents: 2_500_000,
      platform: 'TOAST',
    });
    expect(parseCommerceScenario('anything', 'SHOPIFY').platform).toBe('SHOPIFY');
  });

  it('round trips the item id', () => {
    const spec = parseCommerceScenario('seasonal_sales_40000', 'CLOVER');
    const id = encodeCommerceItemId(spec, 'abc123');
    expect(decodeCommerceItemId(id)).toEqual({
      spec: { ...spec, rentCents: 0 },
      seedHex: 'abc123',
      anchor: null,
      flags: [],
    });
    const anchored = encodeCommerceItemId(spec, 'abc123', '2026-11-09', ['payout_elsewhere']);
    expect(decodeCommerceItemId(anchored)).toMatchObject({
      anchor: '2026-11-09',
      flags: ['payout_elsewhere'],
    });
  });

  it('continues an anchored history so a later pull sees the same past', () => {
    const spec = parseCommerceScenario('healthy_sales_40000', 'SQUARE');
    const atLink = generateSalesAt(spec, 'abcdef123456', AS_OF, AS_OF);
    expect(atLink).toEqual(generateSales(spec, 'abcdef123456', AS_OF));
    const later = generateSalesAt(spec, 'abcdef123456', AS_OF, '2026-12-09');
    expect(later.dailySales.slice(0, atLink.dailySales.length)).toEqual(atLink.dailySales);
    expect(later.dailySales.length).toBeGreaterThan(atLink.dailySales.length + 20);
  });

  it('generates a year of daily sales near the pinned level and is deterministic', () => {
    const spec = parseCommerceScenario('healthy_sales_40000', 'SQUARE');
    const a = generateSales(spec, 'abcdef123456', AS_OF);
    const b = generateSales(spec, 'abcdef123456', AS_OF);
    expect(a).toEqual(b);
    expect(a.connectedSince < '2026-01-01').toBe(true);
    const year = a.dailySales.filter((d) => d.date >= '2025-11-01' && d.date < '2026-11-01');
    const monthlyGross = year.reduce((sum, d) => sum + d.grossCents, 0) / 12;
    expect(monthlyGross).toBeGreaterThan(3_400_000);
    expect(monthlyGross).toBeLessThan(4_600_000);
    const october = year.filter((d) => d.date.startsWith('2026-10'));
    expect(october.every((d) => d.orderCount > 0 && d.cardShareBps <= 10_000)).toBe(true);
    // Closed Mondays, like the sandbox bank.
    expect(october.some((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === 1)).toBe(false);
  });

  it('returns nothing for a platform with no history', () => {
    const spec = parseCommerceScenario('no_balance', 'STRIPE');
    expect(generateSales(spec, 'abcdef123456', AS_OF).dailySales).toEqual([]);
  });
});
