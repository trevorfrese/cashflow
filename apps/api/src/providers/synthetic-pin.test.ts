import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SCENARIOS, generateHistory, parseScenario } from './bank-link/synthetic.ts';
import { generateSales, parseCommerceScenario } from './commerce/synthetic.ts';

/**
 * Pins the exact output of the sandbox generators for existing tokens and seeds. Seed data,
 * item ids stored in the database, and many tests depend on these histories, so any refactor
 * of the generators must leave every digest below unchanged.
 */
const AS_OF = '2026-11-09';
const SEEDS = ['abcdef123456', '0badc0ffee11', '7f3a9c21d4e8'];

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

const TOKENS = [
  ...SCENARIOS,
  'healthy_rev_48000_rent_6200',
  'declining_rev_25000',
  'heavy_debt_rev_90000_rent_4000',
  'batched_rev_30000',
];

function bankDigests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of TOKENS) {
    for (const seed of SEEDS) {
      out[`${token}/${seed}`] = digest(generateHistory(parseScenario(token), seed, AS_OF));
    }
  }
  out['healthy/abcdef123456@2027-03-01'] = digest(
    generateHistory(parseScenario('healthy'), 'abcdef123456', '2027-03-01'),
  );
  return out;
}

function salesDigests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of TOKENS) {
    for (const seed of SEEDS) {
      out[`${token}/${seed}`] = digest(
        generateSales(parseCommerceScenario(token, 'SQUARE'), seed, AS_OF),
      );
    }
  }
  out['toast_seasonal_sales_40000/abcdef123456@2027-03-01'] = digest(
    generateSales(
      parseCommerceScenario('toast_seasonal_sales_40000', 'SQUARE'),
      'abcdef123456',
      '2027-03-01',
    ),
  );
  return out;
}

describe('synthetic generators are pinned', () => {
  it('bank history is byte identical for existing tokens and seeds', () => {
    expect(bankDigests()).toMatchInlineSnapshot(`
      {
        "batched/0badc0ffee11": "3ab6b3aa115d6ac7",
        "batched/7f3a9c21d4e8": "3bf930209a6b7eec",
        "batched/abcdef123456": "5644b7adb9995de6",
        "batched_rev_30000/0badc0ffee11": "9be37b666e3b3326",
        "batched_rev_30000/7f3a9c21d4e8": "785b39c60b3fae90",
        "batched_rev_30000/abcdef123456": "4202b6f11bf861b0",
        "declining/0badc0ffee11": "15607ddb368d0af2",
        "declining/7f3a9c21d4e8": "a262eba370a1012c",
        "declining/abcdef123456": "9c72b319a0684c8d",
        "declining_rev_25000/0badc0ffee11": "f22af6a75f87ef16",
        "declining_rev_25000/7f3a9c21d4e8": "f524fa74d72096c0",
        "declining_rev_25000/abcdef123456": "9e4fb2a8c2a20ca5",
        "growing/0badc0ffee11": "a4fa3412ed99e526",
        "growing/7f3a9c21d4e8": "2388e32a42c866f3",
        "growing/abcdef123456": "bc4d0cce340bb5bd",
        "healthy/0badc0ffee11": "e756864ea718f9c9",
        "healthy/7f3a9c21d4e8": "5be4a35d37cd2a60",
        "healthy/abcdef123456": "967cffaca0b8ab03",
        "healthy/abcdef123456@2027-03-01": "46acdbfd1858b67a",
        "healthy_rev_48000_rent_6200/0badc0ffee11": "b9c18c8e5e5c7257",
        "healthy_rev_48000_rent_6200/7f3a9c21d4e8": "1e55d23cbec311d1",
        "healthy_rev_48000_rent_6200/abcdef123456": "e5d173db82e00cf5",
        "heavy_debt/0badc0ffee11": "43c24e52c5d35211",
        "heavy_debt/7f3a9c21d4e8": "39774a74918bcbbd",
        "heavy_debt/abcdef123456": "4578ee04e3385db5",
        "heavy_debt_rev_90000_rent_4000/0badc0ffee11": "67daab98027d1717",
        "heavy_debt_rev_90000_rent_4000/7f3a9c21d4e8": "03f0c13dad583212",
        "heavy_debt_rev_90000_rent_4000/abcdef123456": "ad5f32bde7db6f26",
        "low_balance/0badc0ffee11": "762bd8802eee4220",
        "low_balance/7f3a9c21d4e8": "61b740f453b6123c",
        "low_balance/abcdef123456": "46b4db76546b2405",
        "new_business/0badc0ffee11": "1850503a4cd718c7",
        "new_business/7f3a9c21d4e8": "fc3c634c3d4943ca",
        "new_business/abcdef123456": "464d454136a0e246",
        "no_balance/0badc0ffee11": "56a8e951cbb41b9f",
        "no_balance/7f3a9c21d4e8": "56a8e951cbb41b9f",
        "no_balance/abcdef123456": "56a8e951cbb41b9f",
        "overdrafts/0badc0ffee11": "cfe15a0ba246afd0",
        "overdrafts/7f3a9c21d4e8": "e7d445e0f88a7da2",
        "overdrafts/abcdef123456": "ff9997ea0396f6f9",
        "seasonal/0badc0ffee11": "b5eae5d114f3a91a",
        "seasonal/7f3a9c21d4e8": "77943675c3ff9c0f",
        "seasonal/abcdef123456": "a106fa351300cf11",
        "thin_margin/0badc0ffee11": "574c906951c000b8",
        "thin_margin/7f3a9c21d4e8": "0bb9e1c5284280b0",
        "thin_margin/abcdef123456": "dff8f524dfc1c10b",
        "volatile/0badc0ffee11": "f9f5de5c6a0afd05",
        "volatile/7f3a9c21d4e8": "79aa3a901f0792ae",
        "volatile/abcdef123456": "084e05fc976a2798",
      }
    `);
  });

  it('platform sales are byte identical for existing tokens and seeds', () => {
    expect(salesDigests()).toMatchInlineSnapshot(`
      {
        "batched/0badc0ffee11": "caac4d1163c636e8",
        "batched/7f3a9c21d4e8": "59f20646c3c2b4af",
        "batched/abcdef123456": "a232bc261566ccad",
        "batched_rev_30000/0badc0ffee11": "d2984b3f9f9bf41b",
        "batched_rev_30000/7f3a9c21d4e8": "ffb1b35620fc732f",
        "batched_rev_30000/abcdef123456": "5ee463f5fc9a5bb8",
        "declining/0badc0ffee11": "8442103ab7f6535b",
        "declining/7f3a9c21d4e8": "ab6545affb0238f4",
        "declining/abcdef123456": "161378e9f3d1e421",
        "declining_rev_25000/0badc0ffee11": "b13851aac7559db4",
        "declining_rev_25000/7f3a9c21d4e8": "bd72c4f27f59ea04",
        "declining_rev_25000/abcdef123456": "35a0328b400293c6",
        "growing/0badc0ffee11": "ba4f765c4b16e6fa",
        "growing/7f3a9c21d4e8": "356f457f8bcaea46",
        "growing/abcdef123456": "98a7e153ac8e68a6",
        "healthy/0badc0ffee11": "caac4d1163c636e8",
        "healthy/7f3a9c21d4e8": "59f20646c3c2b4af",
        "healthy/abcdef123456": "a232bc261566ccad",
        "healthy_rev_48000_rent_6200/0badc0ffee11": "c0ba7b2b0aadee01",
        "healthy_rev_48000_rent_6200/7f3a9c21d4e8": "8dacb920c6b71b1e",
        "healthy_rev_48000_rent_6200/abcdef123456": "7a5525a6f2873bdb",
        "heavy_debt/0badc0ffee11": "caac4d1163c636e8",
        "heavy_debt/7f3a9c21d4e8": "59f20646c3c2b4af",
        "heavy_debt/abcdef123456": "a232bc261566ccad",
        "heavy_debt_rev_90000_rent_4000/0badc0ffee11": "0f23a34847c22d12",
        "heavy_debt_rev_90000_rent_4000/7f3a9c21d4e8": "e8be38033a80c638",
        "heavy_debt_rev_90000_rent_4000/abcdef123456": "4445d02590192396",
        "low_balance/0badc0ffee11": "caac4d1163c636e8",
        "low_balance/7f3a9c21d4e8": "59f20646c3c2b4af",
        "low_balance/abcdef123456": "a232bc261566ccad",
        "new_business/0badc0ffee11": "cd43b8c15e902903",
        "new_business/7f3a9c21d4e8": "69b1aa8c1282c20d",
        "new_business/abcdef123456": "9dcde958f1ff1466",
        "no_balance/0badc0ffee11": "ebc31c6f0b202986",
        "no_balance/7f3a9c21d4e8": "ebc31c6f0b202986",
        "no_balance/abcdef123456": "ebc31c6f0b202986",
        "overdrafts/0badc0ffee11": "caac4d1163c636e8",
        "overdrafts/7f3a9c21d4e8": "59f20646c3c2b4af",
        "overdrafts/abcdef123456": "a232bc261566ccad",
        "seasonal/0badc0ffee11": "9178d1fecab9deba",
        "seasonal/7f3a9c21d4e8": "0165eadef79a5228",
        "seasonal/abcdef123456": "5e095cffcbed8cf0",
        "thin_margin/0badc0ffee11": "caac4d1163c636e8",
        "thin_margin/7f3a9c21d4e8": "59f20646c3c2b4af",
        "thin_margin/abcdef123456": "a232bc261566ccad",
        "toast_seasonal_sales_40000/abcdef123456@2027-03-01": "7d1143b9e7c6e688",
        "volatile/0badc0ffee11": "e5b79447b227f3e6",
        "volatile/7f3a9c21d4e8": "a776a56b167c454f",
        "volatile/abcdef123456": "5dc28cb566e16531",
      }
    `);
  });
});
