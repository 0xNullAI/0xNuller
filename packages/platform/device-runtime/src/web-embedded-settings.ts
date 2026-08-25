export const WEB_EMBEDDED_DEVICES_STORAGE_KEY = '0xnullai.experimental-embedded-devices';

export interface LocalDeviceSettingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PersistedEmbeddedDeviceSetting {
  version: 1;
  enabled: boolean;
}

function defaultStorage(): LocalDeviceSettingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Corrupt, absent, inaccessible, and future settings all fail closed. */
export function readWebEmbeddedDevicesEnabled(
  storage: LocalDeviceSettingStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(WEB_EMBEDDED_DEVICES_STORAGE_KEY);
    if (raw === null) return false;
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      record.version !== 1 ||
      typeof record.enabled !== 'boolean'
    ) {
      return false;
    }
    return record.enabled;
  } catch {
    return false;
  }
}

/** Persists only to this browser profile; no sync or remote store participates. */
export function writeWebEmbeddedDevicesEnabled(
  enabled: boolean,
  storage: LocalDeviceSettingStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const setting: PersistedEmbeddedDeviceSetting = { version: 1, enabled };
  try {
    storage.setItem(WEB_EMBEDDED_DEVICES_STORAGE_KEY, JSON.stringify(setting));
    return true;
  } catch {
    return false;
  }
}
