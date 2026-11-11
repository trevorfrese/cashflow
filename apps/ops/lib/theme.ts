import { brand } from '@cashflow/shared';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The brand tokens from `@cashflow/shared` as CSS custom properties, so the stylesheet
 * names tokens and never repeats a hex value: `brand.colors.brightGold` is
 * `var(--c-bright-gold)`, `brand.radii.card` is `var(--r-card)`.
 */
export function themeCss(): string {
  const lines = [
    ...Object.entries(brand.colors).map(([name, value]) => `--c-${kebab(name)}: ${value};`),
    ...Object.entries(brand.radii).map(([name, value]) => `--r-${kebab(name)}: ${value}px;`),
    ...Object.entries(brand.shadows).map(([name, value]) => `--shadow-${name}: ${value}px;`),
    `--border: ${brand.borderWidth}px;`,
  ];
  return `:root{${lines.join('')}}`;
}
