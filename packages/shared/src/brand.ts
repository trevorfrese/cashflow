/**
 * CashFlow brand tokens, taken from the brand canvas.
 * Gold carries the brand. Charcoal, Forest, or Plum as dark backgrounds.
 */
export const brand = {
  name: 'CashFlow',
  domain: 'splitmylease.com',
  github: 'https://github.com/trevorfrese/cashflow',
  colors: {
    // Coin golds
    highlight: '#FCE7A2',
    gold: '#D8AA36',
    deepGold: '#9C7012',
    bronze: '#5E440A',
    // Dark backgrounds
    charcoal: '#2A2620',
    forest: '#0E241B',
    plum: '#24142F',
    // Neutrals
    ink: '#14120E',
    slate: '#6B655A',
    stone: '#EFEDE8',
    paper: '#FAF8F3',
    white: '#FFFFFF',
    border: '#E4E0D6',
    // Product states
    paid: '#2F7A4D',
    dueSoon: '#B7791F',
    late: '#B42318',
  },
  fonts: {
    /** Wordmark: Archivo at 125% width, weight 800. */
    wordmark: "'Archivo', sans-serif",
    /** UI text. */
    body: "'Inter Tight', 'Inter', system-ui, sans-serif",
  },
  radii: {
    card: 20,
    control: 12,
    chip: 8,
  },
} as const;

export type BrandColor = keyof typeof brand.colors;
