// 图片压缩 + 语音录制 + 上传到 R2（经 Worker /api/upload/:code）。
import type { OutgoingMedia } from '../hooks/use-peer-room';

function genId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

/** 上传媒体 blob 到房间，返回可随聊天消息发出的引用。 */
export async function uploadMedia(
  code: string,
  blob: Blob,
  kind: 'image' | 'audio',
  meta?: { durationMs?: number; w?: number; h?: number },
): Promise<OutgoingMedia> {
  const id = genId();
  const res = await fetch(`/api/upload/${encodeURIComponent(code)}?id=${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return {
    kind,
    id,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
    durationMs: meta?.durationMs,
    w: meta?.w,
    h: meta?.h,
  };
}

/** 将图片缩放压缩为 JPEG（最长边 1280），减小上传体积。 */
export async function compressImage(file: File): Promise<{ blob: Blob; w: number; h: number }> {
  const img = await loadImage(file);
  const maxEdge = 1280;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(img.src);
    throw new Error('canvas 2d context unavailable');
  }
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.82),
  );
  URL.revokeObjectURL(img.src);
  return { blob, w, h };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = URL.createObjectURL(file);
  });
}

export interface Recorder {
  stop(): Promise<{ blob: Blob; durationMs: number }>;
  cancel(): void;
}

/** 选一个浏览器支持的录音 MIME（iOS Safari 回退到 mp4/aac）。 */
function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  const supported = (window as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }).MediaRecorder;
  for (const c of candidates) {
    if (supported?.isTypeSupported?.(c)) return c;
  }
  return '';
}

/** 开始录音；返回的 Recorder.stop() 结束并产出 blob + 时长。 */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickAudioMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => {
    if (e.data.size) chunks.push(e.data);
  };
  const startedAt = Date.now();
  rec.start();

  const cleanup = () => stream.getTracks().forEach(t => t.stop());

  return {
    stop() {
      return new Promise(resolve => {
        rec.onstop = () => {
          cleanup();
          resolve({
            blob: new Blob(chunks, { type: rec.mimeType || 'audio/webm' }),
            durationMs: Date.now() - startedAt,
          });
        };
        rec.stop();
      });
    },
    cancel() {
      cleanup();
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 毫秒格式化为 mm:ss。 */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
