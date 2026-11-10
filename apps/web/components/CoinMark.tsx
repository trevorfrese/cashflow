import { useId } from 'react';

/**
 * The CashFlow coin: a flat gold coin with a shaded inner field and a cents symbol.
 * Taken from the final board of the brand canvas. Pure SVG, scales to any size.
 * Gradient and clip ids are made unique per instance so many coins can share a page.
 */
const SYMBOL = 'M117.92 83.29 A26 26 0 1 0 117.92 116.71';
const BAR = 'M100 55.5 V81.5 M100 118.5 V144.5';

export function CoinMark({
  size = 160,
  title = 'CashFlow coin mark',
  decorative = false,
}: {
  size?: number;
  title?: string;
  decorative?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const clip = `${id}-clip`;
  const ring = `${id}-ring`;
  const sym = `${id}-sym`;
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': title };

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" {...a11y}>
      <defs>
        <clipPath id={clip}>
          <circle cx="100" cy="100" r="60" />
        </clipPath>
        <linearGradient id={ring} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#FFFBD6" />
          <stop offset="0.5" stopColor="#F5B800" />
          <stop offset="1" stopColor="#8F5E00" />
        </linearGradient>
        <linearGradient id={sym} gradientUnits="userSpaceOnUse" x1="62" y1="62" x2="138" y2="138">
          <stop offset="0" stopColor="#FFFCE6" />
          <stop offset="0.25" stopColor="#FFEC8C" />
          <stop offset="1" stopColor="#FFD43B" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="82" fill="#FFD43B" />
      <circle cx="100" cy="100" r="60" fill="#F4B323" />
      <g clipPath={`url(#${clip})`}>
        <circle cx="100" cy="100" r="60" fill="#DE9810" />
        <circle cx="103" cy="104" r="60" fill="#F4B323" />
      </g>
      <circle cx="100" cy="100" r="60.5" fill="none" stroke={`url(#${ring})`} strokeWidth="2.5" />
      <g fill="none" strokeWidth="15" stroke="#FFF6C4" transform="translate(1.5 2)">
        <path d={SYMBOL} />
        <path d={BAR} />
      </g>
      <g fill="none" strokeWidth="15" stroke="#A86E00" transform="translate(-1.2 -1.5)">
        <path d={SYMBOL} />
        <path d={BAR} />
      </g>
      <g fill="none" strokeWidth="15" stroke={`url(#${sym})`}>
        <path d={SYMBOL} />
        <path d={BAR} />
      </g>
    </svg>
  );
}
