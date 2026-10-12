import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

/**
 * Hot updates for the APK's Web UI.
 *
 * The page only moves bytes. Every decision that matters — whether the
 * manifest is signed by the release key, whether it is newer and built for
 * this native layer, whether each file matches its hash, when a bundle may
 * serve and when it is rolled back — is made by `src-tauri/src/ota.rs`.
 */

// A local test build can point at its own server; release builds always use production.
export const OTA_ENDPOINT =
  (import.meta.env.VITE_OTA_ENDPOINT as string | undefined) || 'https://0xnullai.com/ota/android';

export type OtaPhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'reload-required';

export interface OtaUpdateStatus {
  phase: OtaPhase;
  /** The version waiting for the next start. */
  readyVersion: string | null;
  notes: string | null;
}

export interface OtaBundleInfo {
  buildId: string;
  version: string;
  notes: string | null;
}

export interface OtaNativeStatus {
  nativeApi: number;
  embeddedVersion: string;
  active: OtaBundleInfo | null;
  pending: OtaBundleInfo | null;
  confirmed: boolean;
}

interface BeginResult {
  action: 'upToDate' | 'nativeMismatch' | 'download';
  buildId: string;
  version: string;
  missing: string[];
  reloadRequired: boolean;
}

type Invoke = <T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>;

export interface OtaUpdaterOptions {
  endpoint?: string;
  invoke?: Invoke;
  fetchImpl?: typeof fetch;
  firstCheckDelayMs?: number;
  pollIntervalMs?: number;
}

const FIRST_CHECK_DELAY_MS = Number(import.meta.env.VITE_OTA_FIRST_CHECK_MS) || 30_000;
const POLL_INTERVAL_MS = 6 * 60 * 60_000;

export class OtaUpdater {
  private status: OtaUpdateStatus = { phase: 'idle', readyVersion: null, notes: null };
  private readonly listeners = new Set<(status: OtaUpdateStatus) => void>();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private readonly endpoint: string;
  private readonly invoke: Invoke;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OtaUpdaterOptions = {}) {
    this.endpoint = (options.endpoint ?? OTA_ENDPOINT).replace(/\/$/, '');
    this.invoke = options.invoke ?? tauriInvoke;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  start(): void {
    if (this.timeoutId !== null || this.intervalId !== null) return;
    // A bundle downloaded by an earlier run is announced straight away.
    void this.nativeStatus()
      .then((native) => {
        if (native.pending) this.setReady(native.pending);
      })
      .catch(() => undefined);
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.check();
    }, this.options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
    this.intervalId = setInterval(() => {
      void this.check();
    }, this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timeoutId !== null) clearTimeout(this.timeoutId);
    if (this.intervalId !== null) clearInterval(this.intervalId);
    this.timeoutId = null;
    this.intervalId = null;
  }

  getStatus(): OtaUpdateStatus {
    return this.status;
  }

  subscribe(listener: (status: OtaUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  nativeStatus(): Promise<OtaNativeStatus> {
    return this.invoke<OtaNativeStatus>('ota_status');
  }

  /** One check; overlapping calls share the run in flight. */
  check(): Promise<void> {
    this.running ??= this.checkOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Switches to the downloaded UI now. The caller stops device output first. */
  async applyNow(): Promise<void> {
    const switched = await this.invoke<boolean>('ota_apply_now');
    if (switched || this.status.phase === 'reload-required') window.location.reload();
  }

  /** Called once the page has rendered: the running bundle is healthy. */
  async confirm(buildId: string): Promise<void> {
    await this.invoke<boolean>('ota_confirm', { buildId });
  }

  async reset(): Promise<void> {
    await this.invoke('ota_reset');
    window.location.reload();
  }

  private async checkOnce(): Promise<void> {
    if (this.status.phase === 'ready' || this.status.phase === 'reload-required') return;
    this.setPhase('checking');
    try {
      const response = await this.fetchImpl(`${this.endpoint}/latest.json`, { cache: 'no-store' });
      if (!response.ok) return this.setPhase('idle');
      const latest = (await response.json()) as { manifest?: unknown; signature?: unknown };
      if (typeof latest.manifest !== 'string' || typeof latest.signature !== 'string') {
        return this.setPhase('idle');
      }
      const begin = await this.invoke<BeginResult>('ota_begin', {
        manifest: latest.manifest,
        signature: latest.signature,
      });
      if (begin.reloadRequired) {
        // The UI running right now was withdrawn; the previous one is already in place.
        this.status = { phase: 'reload-required', readyVersion: null, notes: null };
        return this.emit();
      }
      if (begin.action !== 'download') return this.setPhase('idle');

      this.setPhase('downloading');
      for (const path of begin.missing) {
        const file = await this.fetchImpl(
          `${this.endpoint}/${begin.buildId}/${path.split('/').map(encodeURIComponent).join('/')}`,
          { cache: 'no-store' },
        );
        if (!file.ok) throw new Error(`download failed: ${path} (${file.status})`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.invoke('ota_write', { buildId: begin.buildId, path, data: toBase64(bytes) });
      }
      const installed = await this.invoke<OtaBundleInfo>('ota_commit', {
        buildId: begin.buildId,
      });
      this.setReady(installed);
    } catch {
      // Offline, a server mid-deploy, or a rejected file: the next check starts over.
      this.setPhase('idle');
    }
  }

  private setReady(bundle: OtaBundleInfo): void {
    this.status = { phase: 'ready', readyVersion: bundle.version, notes: bundle.notes ?? null };
    this.emit();
  }

  private setPhase(phase: OtaPhase): void {
    if (this.status.phase === phase) return;
    this.status = { ...this.status, phase };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

/** Android's IPC bridge carries JSON, so file bytes travel as base64. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** The app-wide updater; one poll loop for the APK's lifetime. */
export const otaUpdater = new OtaUpdater();
