import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@0xnullai/ui';

/** A local drawing stays in page memory until the user previews and explicitly confirms. */
export function CharacterStudioDrawing({
  onSave,
  onClose,
  onDirtyChange,
}: {
  onSave: (png: Blob) => Promise<void>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<number | null>(null);
  const history = useRef<{ pixels: ImageData; painted: boolean }[]>([]);
  const [undoCount, setUndoCount] = useState(0);
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
    if (!context || !node?.toBlob) setError('此浏览器不支持画板，请改用上传图片。');
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
  const remember = (context: CanvasRenderingContext2D) => {
    history.current.push({ pixels: context.getImageData(0, 0, 512, 512), painted });
    if (history.current.length > 20) history.current.shift();
    setUndoCount(history.current.length);
  };
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
      remember(context);
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
    onDirtyChange(true);
  };
  return (
    <section className="space-y-3 rounded-xl border p-3" aria-label="绘制角色头像">
      <p className="text-sm">
        画一个 512 × 512
        头像。支持鼠标和触控；预览确认后上传到公开角色草稿，发布后所有人可见。未确认笔画仅留当前页面。
      </p>
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
              remember(context);
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, 512, 512);
              setPainted(false);
              onDirtyChange(false);
              stroke.current = null;
            }
          }}
        >
          清空画板
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!undoCount || busy || !!preview}
          onClick={() => {
            const previous = history.current.pop();
            const context = canvas.current?.getContext('2d');
            if (previous && context) {
              context.putImageData(previous.pixels, 0, 0);
              setPainted(previous.painted);
              onDirtyChange(previous.painted);
              setUndoCount(history.current.length);
              stroke.current = null;
            }
          }}
        >
          撤销一笔
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
              {busy ? '正在保存…' : '确认上传到公开角色草稿'}
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
              try {
                canvas.current?.toBlob((blob) => {
                  if (!alive.current) return;
                  setBusy(false);
                  if (!blob || blob.size > 4 * 1024 * 1024) {
                    setError('无法导出图片，请换用上传图片。');
                    return;
                  }
                  setPreview({ blob, url: URL.createObjectURL(blob) });
                }, 'image/png');
              } catch {
                setBusy(false);
                setError('无法导出图片，请换用上传图片。');
              }
            }}
          >
            预览头像
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (painted && !window.confirm('放弃尚未上传的手绘头像？')) return;
            onDirtyChange(false);
            onClose();
          }}
        >
          取消绘制
        </Button>
      </div>
    </section>
  );
}
