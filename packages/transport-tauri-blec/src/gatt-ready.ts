/**
 * Retry helper for Android's async GATT service discovery, shared by every
 * Tauri BLE client in this package (Coyote's `TauriBlecDeviceClient`, and
 * the Opossum/sensor clients built on `connectTauriAuxDevice`).
 *
 * plugin-blec's `connect()` resolves before `BluetoothGatt.discoverServices`
 * is guaranteed visible. The first send/subscribe inside a protocol
 * adapter's `onConnected()` then fails with "No services matching UUID".
 * Every adapter resets its own state on a failed `onConnected()`, so
 * retrying it is safe.
 */
export interface GattReadyRetryOptions {
  /**
   * Grace period after `plugin-blec.connect()` resolves, before the first
   * `onConnected()` attempt. Defaults to 300ms.
   */
  gattReadyInitialDelayMs?: number;
  /** Total budget for retrying after the first attempt fails. Defaults to 3000ms. */
  gattReadyTimeoutMs?: number;
  /** Delay between retry attempts. Defaults to 250ms. */
  gattReadyIntervalMs?: number;
  /**
   * Substrings (case-insensitive) that identify a transient GATT-not-ready
   * error from plugin-blec / btleplug, as opposed to a real failure worth
   * surfacing immediately.
   */
  gattReadyErrorPatterns?: string[];
}

export const DEFAULT_GATT_READY_INITIAL_DELAY_MS = 300;
export const DEFAULT_GATT_READY_TIMEOUT_MS = 3000;
export const DEFAULT_GATT_READY_INTERVAL_MS = 250;
export const DEFAULT_GATT_READY_ERROR_PATTERNS = [
  'no services matching',
  'service not found',
  'no such service',
  'characteristic not found',
  'no such characteristic',
  'not connected',
];

export async function runWithGattReadyRetry(
  attempt: () => Promise<void>,
  options: GattReadyRetryOptions,
): Promise<void> {
  const initialDelay = options.gattReadyInitialDelayMs ?? DEFAULT_GATT_READY_INITIAL_DELAY_MS;
  const totalTimeout = options.gattReadyTimeoutMs ?? DEFAULT_GATT_READY_TIMEOUT_MS;
  const interval = options.gattReadyIntervalMs ?? DEFAULT_GATT_READY_INTERVAL_MS;
  const patterns = options.gattReadyErrorPatterns ?? DEFAULT_GATT_READY_ERROR_PATTERNS;

  if (initialDelay > 0) await delay(initialDelay);

  const deadline = Date.now() + Math.max(0, totalTimeout);
  let lastError: unknown;
  // First try after the grace delay; if it works, we're done with one pass.
  while (true) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      if (!isGattNotReadyError(error, patterns)) throw error;
      if (Date.now() >= deadline) break;
      await delay(interval);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('GATT 服务发现超时，请重新连接');
}

function isGattNotReadyError(error: unknown, patterns: string[]): boolean {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
