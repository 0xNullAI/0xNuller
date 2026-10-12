import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@0xnullai/ui';

/** A local drawing stays in page memory until the user previews and explicitly confirms. */
export function CharacterAvatarDrawing({
  onSave,
  onClose,
}: {
  onSave: (png: Blob) => Promise<void>;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<number | null>(null);
  const [color, setColor] = useState('#7c3aed');
  const [width, setWidth] = useState(12);
  const [eraser, setEraser] = useState(false);
  const [ready, setReady] = useState(false);
  const [painted, setPainted] = useState(false);
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const node = canvas.current;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = node?.getContext('2d') ?? null;
    } catch {
      /* Unsupported browser. */
    }
    if (!context || !node?.toBlob) setError('此浏览器不支持画板，请改用上传图片或选择相册。');
    else {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 512, 512);
      setReady(true);
    }
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  const paint = (event: PointerEvent<HTMLCanvasElement>, start: boolean) => {
    if (!ready || busy || preview || (!start && stroke.current !== event.pointerId)) return;
    if (start && (stroke.current !== null || event.button !== 0)) return;
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) * 512) / rect.width;
    const y = ((event.clientY - rect.top) * 512) / rect.height;
    context.strokeStyle = eraser ? '#ffffff' : color;
    context.fillStyle = eraser ? '#ffffff' : color;
    context.lineWidth = width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (start) {
      stroke.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      context.beginPath();
      context.arc(x, y, width / 2, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
      context.stroke();
    }
    setPainted(true);
  };
  return (
    <section className="space-y-3 rounded-xl border p-3" aria-label="绘制角色头像">
      <p className="text-sm">画一个 512 × 512 头像。支持鼠标和触控；确认前不会上传或替换原头像。</p>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label>
          颜色
          <input
            aria-label="画笔颜色"
            type="color"
            value={color}
            disabled={busy || !!preview}
            onChange={(event) => {
              setColor(event.target.value);
              setEraser(false);
            }}
          />
        </label>
        <label>
          笔粗 {width}
          <input
            aria-label="画笔粗细"
            type="range"
            min={2}
            max={50}
            value={width}
            disabled={busy || !!preview}
            onChange={(event) => setWidth(Number(event.target.value))}
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !!preview}
          aria-pressed={eraser}
          onClick={() => setEraser(!eraser)}
        >
          {eraser ? '切回画笔' : '橡皮'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready || busy || !!preview}
          onClick={() => {
            const context = canvas.current?.getContext('2d');
            if (context) {
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, 512, 512);
              setPainted(false);
              stroke.current = null;
            }
          }}
        >
          清空画板
        </Button>
      </div>
      <canvas
        ref={canvas}
        width={512}
        height={512}
        aria-label="头像画板"
        className={`${preview ? 'hidden' : 'block'} aspect-square w-full max-w-sm touch-none rounded-lg border bg-white`}
        onPointerDown={(event) => paint(event, true)}
        onPointerMove={(event) => paint(event, false)}
        onPointerUp={() => {
          stroke.current = null;
        }}
        onPointerCancel={() => {
          stroke.current = null;
        }}
        onLostPointerCapture={() => {
          stroke.current = null;
        }}
      />
      {preview && (
        <img
          src={preview.url}
          alt="待确认的手绘头像"
          className="aspect-square w-full max-w-sm rounded-lg border"
        />
      )}
      <div className="flex flex-wrap gap-2">
        {preview ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await onSave(preview.blob);
                  if (alive.current) onClose();
                } catch (reason) {
                  if (alive.current)
                    setError(reason instanceof Error ? reason.message : '保存失败，请重试');
                } finally {
                  if (alive.current) setBusy(false);
                }
              }}
            >
              {busy ? '正在保存…' : '确认上传并设为私人头像'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPreview(null)}>
              继续修改
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={!ready || !painted || busy}
            onClick={() => {
              setBusy(true);
              canvas.current?.toBlob((blob) => {
                if (!alive.current) return;
                setBusy(false);
                if (!blob) {
                  setError('无法导出图片，请换用上传图片。');
                  return;
                }
                setPreview({ blob, url: URL.createObjectURL(blob) });
              }, 'image/png');
            }}
          >
            预览头像
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} onClick={onClose}>
          取消绘制
        </Button>
      </div>
    </section>
  );
}
