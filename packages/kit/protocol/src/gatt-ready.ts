/**
 * Retry helper for the "GATT services not visible yet" race that hits every
 * BLE transport this library supports, not just Tauri/Android: the
 * underlying platform's `connect()` (Web Bluetooth's `gatt.connect()`,
 * plugin-blec's `connect()` on Android, ...) can resolve before service
 * discovery is guaranteed complete. The first `getPrimaryService()` /
 * subscribe call inside a protocol adapter's `onConnected()` then fails
 * with "No services matching UUID ..." even though the device genuinely
 * has that service — it just hasn't been indexed by the platform's GATT
 * cache yet, most commonly on a first-time pairing.
 *
 * Every protocol adapter resets its own state on a failed `onConnected()`,
 * so retrying it is always safe.
 */
export interface GattReadyRetryOptions {
  /**
   * Grace period after the transport's own `connect()` resolves, before the
   * first `onConnected()` attempt. Defaults to 300ms.
   */
  gattReadyInitialDelayMs?: number;
  /** Total budget for retrying after the first attempt fails. Defaults to 3000ms. */
  gattReadyTimeoutMs?: number;
  /** Delay between retry attempts. Defaults to 250ms. */
  gattReadyIntervalMs?: number;
  /**
   * Substrings (case-insensitive) that identify a transient GATT-not-ready
   * error, as opposed to a real failure worth surfacing immediately.
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
  // Chromium's exact Web Bluetooth wording when the link drops between
  // gatt.connect() resolving and service discovery beginning.
  'gatt server is disconnected',
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
