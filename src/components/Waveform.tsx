/**
 * Decorative animated waveform — one of the few things on this site that
 * actively moves. Used as a sidebar header detail and as a hero strip.
 */

interface WaveformProps {
  /** Width in CSS pixels for the SVG viewBox. */
  width?: number;
  /** Height in CSS pixels. */
  height?: number;
  /** Stroke color (var or rgb). Defaults to var(--accent-strong). */
  color?: string;
  /** Animation speed multiplier. */
  speed?: number;
  /** Optional className for sizing. */
  className?: string;
}

export function Waveform({
  width = 200,
  height = 40,
  color = 'var(--accent-strong)',
  speed = 1,
  className,
}: WaveformProps) {
  // Build a deterministic but lively waveform path.
  const points: string[] = [];
  for (let x = 0; x <= width; x += 4) {
    const t = x / width;
    const y =
      height / 2 +
      Math.sin(t * Math.PI * 6) * (height * 0.28) * Math.sin(t * Math.PI * 1.7) +
      Math.sin(t * Math.PI * 14) * (height * 0.08);
    points.push(`${x},${y.toFixed(1)}`);
  }
  const d = `M ${points[0]} L ${points.slice(1).join(' ')}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      {/* glow underlayer */}
      <path
        d={d}
        stroke={color}
        strokeWidth={3}
        strokeOpacity={0.2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* main */}
      <path
        d={d}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="6 8"
        style={{
          animation: `pulse-flow ${4 / speed}s linear infinite`,
        }}
      />
    </svg>
  );
}
