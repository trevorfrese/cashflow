import { brand } from '@cashflow/shared';
import type { TextStyle, ViewStyle } from 'react-native';

/**
 * Mobile theme built from the shared brand tokens: Paper surfaces, Ink text and lines,
 * Gold for primary actions, Azure for links and connecting, hard offset shadows everywhere.
 */
export const colors = {
  background: brand.colors.paper,
  surface: brand.colors.white,
  surfaceAlt: brand.colors.paper,
  stage: brand.colors.canvas,
  border: brand.colors.ink,
  text: brand.colors.ink,
  textMuted: brand.colors.slate,
  ink: brand.colors.ink,
  paper: brand.colors.paper,
  night: brand.colors.night,
  nightRaised: '#3A3256',
  white: brand.colors.white,
  gold: brand.colors.brightGold,
  goldPressed: '#F2C42A',
  coinGold: brand.colors.gold,
  deepGold: brand.colors.deepGold,
  bronze: brand.colors.bronze,
  cream: brand.colors.cream,
  azure: brand.colors.azure,
  azureDeep: brand.colors.azureDeep,
  magenta: brand.colors.magenta,
  jetRed: brand.colors.jetRed,
  dusk: brand.colors.dusk,
  sky: brand.colors.sky,
  mint: brand.colors.mint,
  stone: brand.colors.stone,
  sand: brand.colors.sand,
  primary: brand.colors.brightGold,
  link: brand.colors.azureDeep,
  paid: brand.colors.paid,
  dueSoon: brand.colors.dueSoon,
  late: brand.colors.late,
  paidText: brand.colors.paidText,
  lateText: brand.colors.lateText,
  successBg: brand.colors.successBg,
  warningBg: brand.colors.warningBg,
  dangerBg: brand.colors.dangerBg,
  infoBg: brand.colors.infoBg,
  errorFieldBg: brand.colors.errorFieldBg,
  selectedBg: brand.colors.selectedBg,
  disabledBg: brand.colors.sand,
  disabledText: '#7A7468',
  disabledBorder: '#7A7468',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  smd: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  card: brand.radii.card,
  control: brand.radii.control,
  chip: brand.radii.tag,
  pill: brand.radii.chip,
  phone: brand.radii.phone,
} as const;

/** Ink lines: 3px on interactive and framed elements, 2px on small chips and dividers. */
export const border = { width: brand.borderWidth, thin: 2 } as const;

/** Archivo, instanced from the Google Fonts variable font. Expanded cuts are the 125% width. */
export const fonts = {
  display: 'ArchivoExpanded-Black',
  heading: 'ArchivoExpanded-ExtraBold',
  regular: 'Archivo-Regular',
  medium: 'Archivo-Medium',
  semibold: 'Archivo-SemiBold',
  bold: 'Archivo-Bold',
} as const;

/* eslint-disable @typescript-eslint/no-require-imports */
export const fontAssets = {
  [fonts.display]: require('../assets/fonts/ArchivoExpanded-Black.ttf'),
  [fonts.heading]: require('../assets/fonts/ArchivoExpanded-ExtraBold.ttf'),
  [fonts.regular]: require('../assets/fonts/Archivo-Regular.ttf'),
  [fonts.medium]: require('../assets/fonts/Archivo-Medium.ttf'),
  [fonts.semibold]: require('../assets/fonts/Archivo-SemiBold.ttf'),
  [fonts.bold]: require('../assets/fonts/Archivo-Bold.ttf'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export const type = {
  display: { fontFamily: fonts.display, fontSize: 34, lineHeight: 38, letterSpacing: -0.5 },
  title: { fontFamily: fonts.heading, fontSize: 26, lineHeight: 30, letterSpacing: -0.3 },
  heading: { fontFamily: fonts.heading, fontSize: 19, lineHeight: 24 },
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22 },
  bodyStrong: { fontFamily: fonts.bold, fontSize: 16, lineHeight: 22 },
  caption: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  label: {
    fontFamily: fonts.bold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  money: { fontFamily: fonts.display, fontSize: 38, lineHeight: 42, letterSpacing: -1 },
  number: { fontFamily: fonts.display, fontSize: 26, lineHeight: 30, letterSpacing: -0.3 },
} as const satisfies Record<string, TextStyle>;

/** Hard shadow offsets in px. Buttons use m, cards l, chips xs. */
export const shadow = { xs: 2, s: 3, m: 4, l: 6, xl: 8 } as const;
export type ShadowSize = keyof typeof shadow;

/**
 * A neo-brutal shadow: solid, no blur, offset down and right. React Native 0.76+ and
 * react-native-web both render the CSS box shadow string.
 */
export function hardShadow(size: ShadowSize | number = 'm', color: string = colors.ink): ViewStyle {
  const px = typeof size === 'number' ? size : shadow[size];
  return { boxShadow: `${px}px ${px}px 0px ${color}` };
}

/** The pressed state: the element sinks into its shadow. */
export function sunk(size: ShadowSize | number = 'm'): ViewStyle {
  const px = typeof size === 'number' ? size : shadow[size];
  return {
    transform: [{ translateX: px }, { translateY: px }],
    boxShadow: '0px 0px 0px transparent',
  };
}
