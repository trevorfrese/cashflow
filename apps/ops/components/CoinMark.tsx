import { useId } from 'react';

import { brand } from '@cashflow/shared';

/** The cents symbol: an open C plus a vertical bar. */
const CENT_ARC = 'M117.92 83.29 A26 26 0 1 0 117.92 116.71';
const CENT_BAR = 'M100 55.5 V81.5 M100 118.5 V144.5';
/** The same symbol grown outward, drawn underneath as the ink outline. */
const CENT_ARC_OUT = 'M120.24 86.53 A26 26 0 1 0 120.24 113.47';
const CENT_BAR_OUT = 'M100 51.5 V81.5 M100 118.5 V148.5';

const { ink, brightGold, gold } = brand.colors;

/**
 * The CashFlow coin from the final board of the brand canvas: a flat two-gold coin with ink
 * outlines, a hard ink drop shadow, and the cents symbol pressed into the face. The same
 * drawing as the mobile app's CoinMark, in plain SVG. Ids are unique per instance so many
 * coins can share a page.
 */
export function CoinMark({
  size = 160,
  title = 'CashFlow coin mark',
  decorative = false,
}: {
  size?: number;
  title?: string;
  decorative?: boolean;
}) {
  const maskId = `coin-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': title };

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" {...a11y}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <g fill="none" stroke="#FFFFFF" strokeWidth="14">
            <path d={CENT_ARC} />
            <path d={CENT_BAR} />
          </g>
        </mask>
      </defs>
      <circle cx="107" cy="107" r="82" fill={ink} />
      <circle cx="100" cy="100" r="82" fill={brightGold} stroke={ink} strokeWidth="6" />
      <circle cx="100" cy="100" r="58" fill={gold} stroke={ink} strokeWidth="4" />
      <g fill="none" stroke={ink} strokeWidth="22">
        <path d={CENT_ARC_OUT} />
        <path d={CENT_BAR_OUT} />
      </g>
      <g mask={`url(#${maskId})`}>
        <rect width="200" height="200" fill={ink} />
        <g fill="none" stroke={brightGold} strokeWidth="14" transform="translate(1.5 1.5)">
          <path d={CENT_ARC} />
          <path d={CENT_BAR} />
        </g>
      </g>
    </svg>
  );
}
