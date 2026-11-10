/**
 * CashFlow brand tokens, from the brand canvas and its design system board: jet-age posters
 * meet neo-brutalism. Flat color, thick Ink lines, hard offset shadows, Archivo set wide.
 * Gold carries the brand on Paper with Ink text. Azure is the accent for primary actions and
 * the app icon. Magenta, Jet Red, Dusk, Sky and Mint are the poster accents.
 */
export const brand = {
  name: 'CashFlow',
  domain: 'splitmylease.com',
  github: 'https://github.com/trevorfrese/cashflow',
  colors: {
    // Core
    ink: '#15121C',
    paper: '#F6EFE1',
    night: '#1C1633',
    white: '#FFFFFF',
    // Coin golds
    brightGold: '#FFD43B',
    gold: '#F4B323',
    deepGold: '#DE9810',
    bronze: '#A86E00',
    cream: '#FFF9D6',
    // Accents
    azure: '#0A7CFF',
    azureDeep: '#0A5FD6',
    magenta: '#E8246F',
    jetRed: '#E0412A',
    dusk: '#F5B5D0',
    sky: '#8FD0FF',
    mint: '#2FB36B',
    // Neutrals
    slate: '#6B655A',
    stone: '#EEE8DB',
    sand: '#E6DFD0',
    canvas: '#E9E0CD',
    border: '#15121C',
    // Product states, used as chip fills
    paid: '#2FB36B',
    dueSoon: '#FFD43B',
    late: '#E0412A',
    // The same states as text on white, dark enough to pass contrast
    paidText: '#1E7A47',
    lateText: '#B42318',
    // Alert and field backgrounds
    successBg: '#DFF6E8',
    warningBg: '#FFF4C2',
    dangerBg: '#FFE1DA',
    infoBg: '#E3F3FF',
    errorFieldBg: '#FFF1EE',
    selectedBg: '#FFF8DA',
  },
  fonts: {
    /** Wordmark and display type: Archivo at 125% width, weight 800 or 900. */
    wordmark: "'Archivo', sans-serif",
    /** Everything else is Archivo at normal width. */
    body: "'Archivo', sans-serif",
  },
  /** 3px Ink on everything interactive. */
  borderWidth: 3,
  /** Hard shadows: no blur, offset down and right by this many px. */
  shadows: { s: 3, m: 5, l: 8 },
  radii: {
    card: 14,
    control: 10,
    chip: 999,
    tag: 6,
    phone: 36,
  },
  spacing: [4, 8, 12, 16, 24, 32, 48],
} as const;

export type BrandColor = keyof typeof brand.colors;
