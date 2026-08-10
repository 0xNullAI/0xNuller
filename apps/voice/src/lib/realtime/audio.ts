/**
 * Browser audio capture/playback for the realtime voice call. Both directions
 * run an `AudioContext` pinned to `SAMPLE_RATE` (24kHz, what xAI/OpenAI/Azure
 * speak natively) rather than resampling after the fact — Chrome resamples
 * the mic input to match a context's requested rate, the same trick
 * DG-Agent's `dashscope-proxy.ts` uses for its 16kHz ASR stream.
 */

export const SAMPLE_RATE = 24000;

interface BrowserAudioWindowLike extends Window {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const win = window as BrowserAudioWindowLike;
  return win.AudioContext ?? win.webkitAudioContext;
}

export function isRealtimeAudioSupported(): boolean {
  return Boolean(
    getAudioContextCtor() &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof WebSocket !== 'undefined',
  );
}

export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i] ?? 0));
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16;
}

export function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / (int16[i]! < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

export function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/** GLM-realtime wants wav-framed chunks, not raw pcm16 — wraps one chunk as a standalone 16-bit mono wav. */
export function wrapPcm16AsWav(int16: Int16Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const dataSize = int16.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));

  return buffer;
}

const PCM_CAPTURE_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._batchSize = 1200; // 50ms @ 24kHz
    this._buffer = new Float32Array(this._batchSize);
    this._filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(this._batchSize - this._filled, channel.length - offset);
      this._buffer.set(channel.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;
      if (this._filled >= this._batchSize) {
        this.port.postMessage(this._buffer.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

let workletModuleUrl: string | null = null;

/**
 * Captures the mic as 50ms Float32 frames at 24kHz. Buffers frames produced
 * before the caller attaches a listener (xAI's own guidance: don't wait for
 * the WebSocket to open before opening the mic — buffer then flush) via
 * `drainBuffered()`.
 */
export class MicCapture {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private listener: ((frame: Float32Array) => void) | null = null;
  private buffered: Float32Array[] = [];

  async start(): Promise<void> {
    if (!isRealtimeAudioSupported()) {
      throw new Error('当前浏览器不支持实时语音所需的音频能力');
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const AudioContextCtor = getAudioContextCtor()!;
    this.audioContext = new AudioContextCtor({ sampleRate: SAMPLE_RATE });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    if (!this.audioContext.audioWorklet) {
      throw new Error('当前浏览器无法使用 AudioWorklet');
    }
    if (!workletModuleUrl) {
      workletModuleUrl = URL.createObjectURL(
        new Blob([PCM_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }),
      );
    }
    await this.audioContext.audioWorklet.addModule(workletModuleUrl);

    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
    this.workletNode.port.onmessage = (event) => {
      const frame = event.data as Float32Array;
      if (this.listener) {
        this.listener(frame);
      } else {
        this.buffered.push(frame);
      }
    };

    source.connect(this.workletNode);
    // Worklet output is unused (capture-only) but Chrome requires the graph
    // to reach a destination for `process()` to keep firing.
    const silence = this.audioContext.createGain();
    silence.gain.value = 0;
    this.workletNode.connect(silence);
    silence.connect(this.audioContext.destination);
  }

  /** Attaches the frame listener and immediately flushes anything captured before this call. */
  onFrame(listener: (frame: Float32Array) => void): void {
    this.listener = listener;
    if (this.buffered.length > 0) {
      const pending = this.buffered;
      this.buffered = [];
      for (const frame of pending) listener(frame);
    }
  }

  stop(): void {
    this.listener = null;
    this.buffered = [];
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }
}

/**
 * Schedules incoming PCM16 chunks back-to-back on an output `AudioContext`.
 * `whenDrained()` is how `VoiceToolBridge` waits for "audio has finished
 * playing" before sending `response.create` for a queued tool result —
 * sending it too early causes two responses' audio to overlap.
 */
export class AudioPlayback {
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) throw new Error('当前浏览器无法使用 AudioContext');
      this.audioContext = new AudioContextCtor({ sampleRate: SAMPLE_RATE });
    }
    return this.audioContext;
  }

  /**
   * Creates (if needed) and resumes the output `AudioContext` while still
   * inside the "开始通话" click's transient user-activation window — call
   * this from `connect()`, not lazily on the first `response.audio.delta`.
   * A context created later, from a WebSocket message handler with no
   * gesture behind it, is born `suspended` under Chrome's autoplay policy:
   * audio gets scheduled and decoded correctly but never actually plays,
   * with no error anywhere — the exact "I can talk but hear nothing back"
   * symptom. `enqueuePcm16()` also resumes defensively in case the context
   * reverts to suspended (e.g. after a tab is backgrounded and returns).
   */
  async prepare(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
  }

  enqueuePcm16(int16: Int16Array): void {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const float32 = int16ToFloat32(int16);
    const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
  }

  isPlaying(): boolean {
    return this.audioContext !== null && this.nextStartTime > this.audioContext.currentTime;
  }

  /** Resolves once every scheduled chunk has finished playing (polls — Web Audio has no native "drained" event). */
  whenDrained(): Promise<void> {
    if (!this.isPlaying()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.isPlaying()) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /** Cuts off playback immediately — used when the user (or server VAD) interrupts the assistant mid-sentence. */
  clear(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.activeSources.clear();
    this.nextStartTime = this.audioContext?.currentTime ?? 0;
  }

  close(): void {
    this.clear();
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }
}
