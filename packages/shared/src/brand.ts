/**
 * CashFlow brand tokens, taken from the final board of the brand canvas.
 * Gold carries the brand on Paper. Azure is the accent for actions and the app icon.
 */
export const brand = {
  name: 'CashFlow',
  domain: 'splitmylease.com',
  github: 'https://github.com/trevorfrese/cashflow',
  colors: {
    // Coin golds
    brightGold: '#FFD43B',
    gold: '#F4B323',
    deepGold: '#DE9810',
    bronze: '#A86E00',
    cream: '#FFF9D6',
    // Accent
    azure: '#0A7CFF',
    azureDeep: '#0866D6',
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
