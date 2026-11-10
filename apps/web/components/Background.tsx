/**
 * Ambient background: a slow mesh gradient (four large blurred color fields drifting past
 * each other) with a fine grain overlay. Pure CSS animation, no JS. Honors prefers-reduced-motion.
 */
export function Background() {
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg-mesh bg-mesh-a" />
      <div className="bg-mesh bg-mesh-b" />
      <div className="bg-mesh bg-mesh-c" />
      <div className="bg-mesh bg-mesh-d" />
      <svg className="bg-grain">
        <filter id="bgGrain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#bgGrain)" />
      </svg>
    </div>
  );
}
