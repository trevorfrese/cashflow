import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';

const SYMBOL = 'M117.92 83.29 A26 26 0 1 0 117.92 116.71';
const BAR = 'M100 55.5 V81.5 M100 118.5 V144.5';

/** The CashFlow coin from the brand canvas: flat gold coin with a cents symbol. */
export function CoinMark({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" accessibilityRole="image">
      <Defs>
        <ClipPath id="coinClip">
          <Circle cx="100" cy="100" r="60" />
        </ClipPath>
        <LinearGradient id="coinRing" x1="1" y1="1" x2="0" y2="0">
          <Stop offset="0" stopColor="#FFFBD6" />
          <Stop offset="0.5" stopColor="#F5B800" />
          <Stop offset="1" stopColor="#8F5E00" />
        </LinearGradient>
        <LinearGradient
          id="coinSym"
          gradientUnits="userSpaceOnUse"
          x1="62"
          y1="62"
          x2="138"
          y2="138"
        >
          <Stop offset="0" stopColor="#FFFCE6" />
          <Stop offset="0.25" stopColor="#FFEC8C" />
          <Stop offset="1" stopColor="#FFD43B" />
        </LinearGradient>
      </Defs>
      <Circle cx="100" cy="100" r="82" fill="#FFD43B" />
      <Circle cx="100" cy="100" r="60" fill="#F4B323" />
      <G clipPath="url(#coinClip)">
        <Circle cx="100" cy="100" r="60" fill="#DE9810" />
        <Circle cx="103" cy="104" r="60" fill="#F4B323" />
      </G>
      <Circle cx="100" cy="100" r="60.5" fill="none" stroke="url(#coinRing)" strokeWidth="2.5" />
      <G fill="none" strokeWidth="15" stroke="#FFF6C4" transform="translate(1.5 2)">
        <Path d={SYMBOL} />
        <Path d={BAR} />
      </G>
      <G fill="none" strokeWidth="15" stroke="#A86E00" transform="translate(-1.2 -1.5)">
        <Path d={SYMBOL} />
        <Path d={BAR} />
      </G>
      <G fill="none" strokeWidth="15" stroke="url(#coinSym)">
        <Path d={SYMBOL} />
        <Path d={BAR} />
      </G>
    </Svg>
  );
}
