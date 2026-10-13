import { invoke } from '@tauri-apps/api/core';
import type { NativeStopRecipe } from '@dg-kit/protocol';

/**
 * The native safety floor in plugin-blec: a stop the plugin can write on its own.
 *
 * Once armed for an address, the plugin keeps that device's stop packet and writes it, ahead of
 * anything queued, when the app leaves the foreground, when asked to here, or when no write has
 * reached the device for `NATIVE_WATCHDOG_MS` (the tick writes every 100 ms while output runs, so
 * a silent link means this page stopped running). The bytes come from the protocol adapter; the
 * plugin never encodes a protocol.
 *
 * Every call is best effort: an APK whose plugin predates these commands rejects them, and the
 * page's own stop path still runs.
 */

export const NATIVE_WATCHDOG_MS = 1_500;

/** Register (or replace) the device's stop packet with the plugin. */
export async function armNativeStop(
  address: string,
  recipe: NativeStopRecipe | null | undefined,
): Promise<boolean> {
  if (!address || !recipe) return false;
  try {
    await invoke('plugin:blec|set_safety_stop', {
      address,
      service: recipe.service,
      characteristic: recipe.characteristic,
      packet: Array.from(recipe.packet),
      watchdogMs: NATIVE_WATCHDOG_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** Write the registered stop packet now, ahead of any queued write. False when it did not. */
export async function nativeStop(address: string | null): Promise<boolean> {
  if (!address) return false;
  try {
    await invoke('plugin:blec|safety_stop', { address });
    return true;
  } catch {
    return false;
  }
}
