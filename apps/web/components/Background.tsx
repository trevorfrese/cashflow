/**
 * Ambient background: a faint dot grid, two slow drifting gold glows, and a very large,
 * slowly turning reeded ring that echoes the coin's edge. Pure CSS animation, no JS.
 * Honors prefers-reduced-motion.
 */
const TICKS = 120;

export function Background() {
  const ticks = Array.from({ length: TICKS }, (_, i) => (360 / TICKS) * i);
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg-grid" />
      <div className="bg-glow bg-glow-a" />
      <div className="bg-glow bg-glow-b" />
      <svg className="bg-ring" viewBox="0 0 1000 1000">
        <circle cx="500" cy="500" r="470" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle cx="500" cy="500" r="430" fill="none" stroke="currentColor" strokeWidth="1" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {ticks.map((deg) => (
            <line
              key={deg}
              x1="500"
              y1="36"
              x2="500"
              y2="64"
              transform={`rotate(${deg} 500 500)`}
            />
          ))}
        </g>
      </svg>
      <svg className="bg-ring bg-ring-inner" viewBox="0 0 1000 1000">
        <circle cx="500" cy="500" r="300" fill="none" stroke="currentColor" strokeWidth="1" />
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          {ticks
            .filter((_, i) => i % 2 === 0)
            .map((deg) => (
              <line
                key={deg}
                x1="500"
                y1="212"
                x2="500"
                y2="232"
                transform={`rotate(${deg} 500 500)`}
              />
            ))}
        </g>
      </svg>
    </div>
  );
}
