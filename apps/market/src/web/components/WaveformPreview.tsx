import { useEffect, useRef } from 'react';

interface Props {
  frames: [number, number][];
  height?: number;
}

// 把 frames 的强度画成柱状轮廓，颜色随频率深浅变化。
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
    // 用主题强调色（浅色青 / 深色暖黄），与主站一致；频率高低用透明度区分。
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
