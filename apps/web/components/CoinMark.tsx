/**
 * The CashFlow coin: a face-on gold coin with a beveled rim, reeded edge, and an engraved C.
 * Taken from the brand canvas (logo v1). Pure SVG, scales to any size.
 */
const TICKS = 44;

export function CoinMark({
  size = 160,
  title = 'CashFlow coin mark',
  decorative = false,
}: {
  size?: number;
  title?: string;
  decorative?: boolean;
}) {
  const ticks = Array.from({ length: TICKS }, (_, i) => (360 / TICKS) * i);
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': title };

  return (
    <svg width={size} height={size} viewBox="0 0 200 200" {...a11y}>
      <defs>
        <radialGradient id="cfFace" cx="0.38" cy="0.32" r="0.8">
          <stop offset="0" stopColor="#FCE7A2" />
          <stop offset="0.55" stopColor="#D8AA36" />
          <stop offset="1" stopColor="#9C7012" />
        </radialGradient>
        <linearGradient id="cfRim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFF3C8" />
          <stop offset="0.5" stopColor="#C99A2A" />
          <stop offset="1" stopColor="#6E500C" />
        </linearGradient>
        <linearGradient id="cfRimIn" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#FFF3C8" />
          <stop offset="0.5" stopColor="#C99A2A" />
          <stop offset="1" stopColor="#6E500C" />
        </linearGradient>
        <linearGradient id="cfField" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#EBC660" />
          <stop offset="1" stopColor="#BE901F" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="82" fill="url(#cfFace)" />
      <circle cx="100" cy="100" r="79" fill="none" stroke="url(#cfRim)" strokeWidth="5" />
      <g
        transform="translate(4 0)"
        stroke="#7A5A0E"
        strokeOpacity="0.7"
        strokeWidth="2.4"
        strokeLinecap="round"
      >
        {ticks.map((deg) => (
          <line key={deg} x1="96" y1="28" x2="96" y2="34" transform={`rotate(${deg} 96 100)`} />
        ))}
      </g>
      <circle cx="100" cy="100" r="58" fill="url(#cfField)" />
      <circle cx="100" cy="100" r="58" fill="none" stroke="url(#cfRimIn)" strokeWidth="2.5" />
      <path
        d="M120.92 84.29 A26 26 0 1 0 120.92 117.71"
        fill="none"
        stroke="#FCE7A2"
        strokeWidth="15"
      />
      <path
        d="M119.92 83.29 A26 26 0 1 0 119.92 116.71"
        fill="none"
        stroke="#5E440A"
        strokeWidth="15"
      />
    </svg>
  );
}
