/**
 * Per-device output limits, remembered by a stable device key.
 *
 * These sit on top of the global per-type caps in `device-safety.ts`: the limit that reaches a
 * device channel is `min(global type cap, this device's own cap)`, re-applied by the device
 * holder on every write. A device's own cap can therefore only ever make it stricter than the
 * global setting, never looser.
 *
 * Keys are opaque stable keys from `@0xnullai/device-runtime` (`deriveDgLabStableKey`), never
 * the per-connection target id, so a cap survives reconnects and app restarts.
 */

export type DeviceLimitKind = 'coyote' | 'opossum';

export interface DeviceOwnLimits {
  a: number;
  b: number;
  /** Last name the device reported. Display only; never used to route or match. */
  name?: string;
  kind: DeviceLimitKind;
}

export type DeviceOwnLimitsMap = Readonly<Record<string, DeviceOwnLimits>>;

/** The protocol range of both Coyote strength and Opossum intensity. */
export const DEVICE_LIMIT_MAX = 200;

/** A remembered device with no explicit cap: adds no restriction beyond the global one. */
export const DEFAULT_DEVICE_OWN_LIMIT = DEVICE_LIMIT_MAX;

const KEY = '0xnullai.device-limits';
const MAX_NAME_LENGTH = 64;

const listeners = new Set<(limits: DeviceOwnLimitsMap) => void>();
/** Holds the last save when storage refused it, so a lowered cap still applies this session. */
let unsavedRecords: Record<string, DeviceOwnLimits> | null = null;

function clampLimit(value: number): number {
  return Math.max(0, Math.min(DEVICE_LIMIT_MAX, Math.round(value)));
}

/** One validated record, or null. Corrupted records are dropped, never partially trusted. */
function coerceRecord(raw: unknown): DeviceOwnLimits | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'coyote' && o.kind !== 'opossum') return null;
  if (typeof o.a !== 'number' || !Number.isFinite(o.a)) return null;
  if (typeof o.b !== 'number' || !Number.isFinite(o.b)) return null;
  const record: DeviceOwnLimits = { kind: o.kind, a: clampLimit(o.a), b: clampLimit(o.b) };
  if (typeof o.name === 'string' && o.name.trim()) {
    record.name = o.name.trim().slice(0, MAX_NAME_LENGTH);
  }
  return record;
}

function coerceMap(raw: unknown): Record<string, DeviceOwnLimits> {
  const out: Record<string, DeviceOwnLimits> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) continue;
    const record = coerceRecord(value);
    if (record) out[key] = record;
  }
  return out;
}

/** Every remembered device's record. Corrupted storage yields `{}` (global caps still apply). */
export function loadDeviceLimits(): Record<string, DeviceOwnLimits> {
  if (unsavedRecords) return cloneMap(unsavedRecords);
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? coerceMap(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** One device's record, or null when the device is not remembered. */
export function loadDeviceLimit(stableKey: string): DeviceOwnLimits | null {
  return loadDeviceLimits()[stableKey] ?? null;
}

function save(records: Record<string, DeviceOwnLimits>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
    unsavedRecords = null;
  } catch {
    // Keep the values for this session: a cap the user just lowered must not silently revert.
    unsavedRecords = cloneMap(records);
  }
  const snapshot = Object.freeze(cloneMap(records));
  for (const listener of [...listeners]) listener(snapshot);
}

export interface DeviceLimitPatch {
  kind: DeviceLimitKind;
  a?: number;
  b?: number;
  name?: string;
}

/**
 * Create or update one device's record. Omitted channels keep their stored value (or the
 * no-restriction default for a new record). Values are clamped to 0..200; a non-finite value
 * is ignored rather than written.
 */
export function updateDeviceLimit(stableKey: string, patch: DeviceLimitPatch): DeviceOwnLimits {
  const key = stableKey.trim();
  if (!key) throw new Error('设备标识无效');
  const records = loadDeviceLimits();
  const previous = records[key];
  // A key never changes kind; a mismatch means a stale caller, so start the record fresh.
  const base =
    previous && previous.kind === patch.kind
      ? previous
      : { kind: patch.kind, a: DEFAULT_DEVICE_OWN_LIMIT, b: DEFAULT_DEVICE_OWN_LIMIT };
  const next = coerceRecord({
    kind: patch.kind,
    a: typeof patch.a === 'number' && Number.isFinite(patch.a) ? patch.a : base.a,
    b: typeof patch.b === 'number' && Number.isFinite(patch.b) ? patch.b : base.b,
    name: patch.name ?? base.name,
  })!;
  if (previous && sameRecord(previous, next)) return { ...next };
  records[key] = next;
  save(records);
  return { ...next };
}

/** Forget one device. Its next connection starts again from the global caps alone. */
export function removeDeviceLimit(stableKey: string): void {
  const records = loadDeviceLimits();
  if (!(stableKey in records)) return;
  delete records[stableKey];
  save(records);
}

export function subscribeDeviceLimits(listener: (limits: DeviceOwnLimitsMap) => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener(Object.freeze(loadDeviceLimits()));
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function sameRecord(x: DeviceOwnLimits, y: DeviceOwnLimits): boolean {
  return x.kind === y.kind && x.a === y.a && x.b === y.b && x.name === y.name;
}

function cloneMap(records: Record<string, DeviceOwnLimits>): Record<string, DeviceOwnLimits> {
  const out: Record<string, DeviceOwnLimits> = {};
  for (const [key, record] of Object.entries(records)) out[key] = { ...record };
  return out;
}
