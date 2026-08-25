import { invoke } from '@tauri-apps/api/core';

interface ScannerClaimResponse {
  leaseId: string;
}

export interface ScannerCoordinationApi {
  claim(): Promise<string>;
  release(leaseId: string): Promise<void>;
}

let injected: ScannerCoordinationApi | undefined;

export function __setScannerCoordinationForTests(api: ScannerCoordinationApi | undefined): void {
  injected = api;
}

function resolveScannerCoordination(): ScannerCoordinationApi {
  if (injected) return injected;

  const win = (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window;
  if (!win?.__TAURI_INTERNALS__) {
    // The BLE plugin itself cannot resolve outside Tauri. Keeping this seam a
    // no-op there lets injected plugin test doubles and package-level tooling
    // exercise scan behavior without pretending native ownership exists.
    return {
      claim: async () => 'non-tauri',
      release: async () => undefined,
    };
  }

  return {
    claim: async () => {
      try {
        const response = await invoke<ScannerClaimResponse>('dg_blec_claim_scanner');
        return response.leaseId;
      } catch (cause) {
        const error = new Error('蓝牙扫描器正由其他设备后端使用');
        (error as Error & { cause?: unknown }).cause = cause;
        throw error;
      }
    },
    release: (leaseId) => invoke<void>('dg_blec_release_scanner', { request: { leaseId } }),
  };
}

/**
 * One native scanner claim. Cleanup first confirms plugin-blec scan teardown,
 * then runs any post-scan GATT cleanup, and only then releases native ownership.
 */
export class DgScannerLease {
  private cleanupPromise: Promise<void> | null = null;
  private released = false;

  private constructor(
    private readonly coordination: ScannerCoordinationApi,
    private readonly leaseId: string,
  ) {}

  static async claim(): Promise<DgScannerLease> {
    const coordination = resolveScannerCoordination();
    const leaseId = await coordination.claim();
    return new DgScannerLease(coordination, leaseId);
  }

  get isReleased(): boolean {
    return this.released;
  }

  cleanup(stopScan: () => Promise<void>, afterStop?: () => Promise<void>): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;

    this.cleanupPromise = (async () => {
      await stopScan();
      await afterStop?.();
      await this.coordination.release(this.leaseId);
      this.released = true;
    })().catch((error: unknown) => {
      // A native stop/release failure leaves the claim held. Permit explicit
      // teardown to retry, but never report the scanner as available early.
      this.cleanupPromise = null;
      throw error;
    });
    return this.cleanupPromise;
  }
}
