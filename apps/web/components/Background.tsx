/**
 * Ambient background: a faint dot grid, two slow drifting gold glows, and three slow flowing
 * ribbons (long sine waves sliding horizontally) that nod to the name. Pure CSS animation,
 * no JS. Honors prefers-reduced-motion.
 */

// One period of a sine wave is 1200 units wide. Each path repeats the wave twice (2400 wide)
// so translating by exactly 1200 loops seamlessly.
function wavePath(amplitude: number, yOffset: number): string {
  const period = 1200;
  const segments = 48;
  const points: string[] = [];
  for (let i = 0; i <= segments * 2; i++) {
    const x = (i / segments) * period;
    const y = yOffset + Math.sin((x / period) * Math.PI * 2) * amplitude;
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join(' ');
}

const RIBBONS = [
  { amplitude: 60, y: 300, className: 'bg-ribbon bg-ribbon-d' },
  { amplitude: 70, y: 420, className: 'bg-ribbon bg-ribbon-a' },
  { amplitude: 95, y: 560, className: 'bg-ribbon bg-ribbon-b' },
  { amplitude: 55, y: 700, className: 'bg-ribbon bg-ribbon-c' },
  { amplitude: 80, y: 820, className: 'bg-ribbon bg-ribbon-e' },
];

export function Background() {
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg-grid" />
      <div className="bg-glow bg-glow-a" />
      <div className="bg-glow bg-glow-b" />
      <div className="bg-ribbons">
        {RIBBONS.map((r) => (
          <svg key={r.className} className={r.className} viewBox="0 0 1200 1000" preserveAspectRatio="none">
            <path d={wavePath(r.amplitude, r.y)} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        ))}
      </div>
    </div>
  );
}
