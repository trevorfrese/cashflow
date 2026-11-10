import { brand } from '@cashflow/shared';

/**
 * Mobile theme built from the shared brand tokens. Light surface (Paper) with Ink text,
 * gold for the brand, Azure for primary actions, and the product state colors.
 */
export const colors = {
  background: brand.colors.paper,
  surface: brand.colors.white,
  surfaceAlt: brand.colors.stone,
  border: brand.colors.border,
  text: brand.colors.ink,
  textMuted: brand.colors.slate,
  gold: brand.colors.gold,
  brightGold: brand.colors.brightGold,
  deepGold: brand.colors.deepGold,
  cream: brand.colors.cream,
  bronze: brand.colors.bronze,
  paper: brand.colors.paper,
  stone: brand.colors.stone,
  white: brand.colors.white,
  primary: brand.colors.azure,
  primaryPressed: brand.colors.azureDeep,
  onPrimary: brand.colors.white,
  paid: brand.colors.paid,
  dueSoon: brand.colors.dueSoon,
  late: brand.colors.late,
  dangerBg: '#FBEAE7',
  successBg: '#E6F2EA',
  warningBg: '#FBF1DC',
  infoBg: '#E6F1FF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  card: brand.radii.card,
  control: brand.radii.control,
  chip: brand.radii.chip,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '800' as const, letterSpacing: -0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  money: { fontSize: 40, lineHeight: 46, fontWeight: '800' as const, letterSpacing: -1 },
} as const;
