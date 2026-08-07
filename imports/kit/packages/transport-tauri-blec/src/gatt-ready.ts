/**
 * Re-exported from `@dg-kit/protocol` — this retry logic isn't Tauri/Android
 * specific (Web Bluetooth hits the identical "GATT services not visible
 * yet" race after `gatt.connect()` resolves), so it moved to the
 * transport-agnostic protocol layer. Kept as a re-export here rather than
 * updating every internal import in this package, and so any external
 * consumer importing from `@dg-kit/transport-tauri-blec` directly doesn't
 * break.
 */
export {
  runWithGattReadyRetry,
  DEFAULT_GATT_READY_INITIAL_DELAY_MS,
  DEFAULT_GATT_READY_TIMEOUT_MS,
  DEFAULT_GATT_READY_INTERVAL_MS,
  DEFAULT_GATT_READY_ERROR_PATTERNS,
  type GattReadyRetryOptions,
} from '@dg-kit/protocol';
