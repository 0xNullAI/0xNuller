import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

interface Props {
  frames: [number, number][];
  height?: number;
}

// Draw the frames' strength as a bar outline, with the color shading by frequency.
export function WaveformPreview({ frames, height = 64 }: Props): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (frames.length === 0) return;
    // Use the theme accent color (cyan in light / warm yellow in dark) to match the main
    // site; frequency is distinguished by opacity.
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#58c8f2';
    const barW = w / frames.length;
    frames.forEach(([freq, strength], i) => {
      const barH = (strength / 100) * (h - 4);
      ctx.globalAlpha = 0.45 + ((freq - 10) / 230) * 0.55;
      ctx.fillStyle = accent;
      ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 0.5), barH);
    });
    ctx.globalAlpha = 1;
  }, [frames, height]);

  return <canvas ref={ref} className="wave-canvas" style={{ height }} />;
}
