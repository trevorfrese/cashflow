import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

export type IconName =
  | 'arrow-right'
  | 'arrow-left'
  | 'plus'
  | 'check'
  | 'close'
  | 'alert'
  | 'calendar'
  | 'home'
  | 'receipt'
  | 'settings'
  | 'clock'
  | 'chevron-down'
  | 'chevron-right'
  | 'search';

/** Stroke icons drawn to match the 3px ink lines of the design system. */
export function Icon({
  name,
  size = 22,
  color = colors.ink,
  strokeWidth = 3,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const common = {
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" pointerEvents="none">
      {name === 'arrow-right' ? <Path d="M5 12h14M13 6l6 6-6 6" {...common} /> : null}
      {name === 'arrow-left' ? <Path d="M19 12H5M11 6l-6 6 6 6" {...common} /> : null}
      {name === 'plus' ? <Path d="M12 5v14M5 12h14" {...common} /> : null}
      {name === 'check' ? <Path d="M5 12l5 5 9-10" {...common} /> : null}
      {name === 'close' ? <Path d="M6 6l12 12M18 6L6 18" {...common} /> : null}
      {name === 'alert' ? (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Path d="M12 7v6M12 17h.01" {...common} />
        </>
      ) : null}
      {name === 'calendar' ? (
        <>
          <Rect x="4" y="5" width="16" height="15" rx="2" {...common} />
          <Path d="M4 10h16M9 3v4M15 3v4" {...common} />
        </>
      ) : null}
      {name === 'home' ? (
        <Path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" {...common} />
      ) : null}
      {name === 'clock' ? (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Path d="M12 7v5l3 2" {...common} />
        </>
      ) : null}
      {name === 'receipt' ? (
        <Path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" {...common} />
      ) : null}
      {name === 'settings' ? (
        <>
          <Circle cx="12" cy="12" r="3" {...common} />
          <Path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            {...common}
          />
        </>
      ) : null}
      {name === 'chevron-down' ? <Path d="M6 9l6 6 6-6" {...common} /> : null}
      {name === 'chevron-right' ? <Path d="M9 6l6 6-6 6" {...common} /> : null}
      {name === 'search' ? (
        <>
          <Circle cx="11" cy="11" r="7" {...common} />
          <Path d="M20 20l-4-4" {...common} />
        </>
      ) : null}
    </Svg>
  );
}
