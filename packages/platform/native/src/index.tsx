import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import {
  createWebBluetoothDgLabTransport,
  DgLabConnectionRegistry,
} from '@0xnullai/device-runtime';
import { loadDeviceSafety } from '@0xnullai/settings';

/**
 * The single entry point where a shell injects capabilities into modules.
 *
 * Devices: the shell builds one `DgLabConnectionRegistry` before render and passes it as
 * `dglab`. Every module (Control, Agent, Voice, Video, Chat, Playground) reads it through
 * `useDgLabRegistry()` and opens no BLE link of its own. There is no per-module device seam:
 * before the shared registry each module had one, and the same Coyote could carry two adapters.
 *
 * Context instead of prop drilling: the shell lazy-loads modules by route,
 * so props would thread through ModuleSlot / Suspense / ErrorBoundary and
 * every new module would touch the shell again.
 *
 * Every item is optional: absence falls back to the web implementation
 * instead of throwing.
 */

export interface NativeBridge {
  /**
   * The one DG-Lab connection owner for the whole app instance, built by the shell before render.
   * Modules read it through `useDgLabRegistry()`.
   */
  dglab?: DgLabConnectionRegistry;
  /**
   * Agent's non-device service flags (speech, bridge, update checker). Shape mirrors
   * apps/agent `ServicesOverrides`.
   */
  agent?: {
    servicesOverrides?: unknown;
  };
}

interface BridgeContextValue {
  bridge: NativeBridge;
  native: boolean;
}

const Ctx = createContext<BridgeContextValue | null>(null);

export function NativeBridgeProvider({
  bridge,
  children,
  native = true,
}: {
  bridge: NativeBridge;
  children: ReactNode;
  /** Web also supplies the shared registry through this seam without pretending to be Tauri. */
  native?: boolean;
}) {
  return <Ctx.Provider value={{ bridge, native }}>{children}</Ctx.Provider>;
}

/** Get shell capabilities. Standalone module builds return an empty object. */
export function useNativeBridge(): NativeBridge {
  return useContext(Ctx)?.bridge ?? EMPTY;
}

/**
 * The shell's DG-Lab registry, or a lazily built Web Bluetooth one in a standalone module build.
 *
 * The fallback is a module-level singleton, so a standalone build still has exactly one owner per
 * physical device however many components call this hook.
 */
export function useDgLabRegistry(): DgLabConnectionRegistry {
  return useNativeBridge().dglab ?? standaloneDgLabRegistry();
}

let standaloneRegistry: DgLabConnectionRegistry | null = null;

function standaloneDgLabRegistry(): DgLabConnectionRegistry {
  standaloneRegistry ??= new DgLabConnectionRegistry({
    transport: createWebBluetoothDgLabTransport(),
    limits: loadDeviceSafety,
  });
  return standaloneRegistry;
}

const EMPTY: NativeBridge = {};

/** Whether the active shell is native rather than Web. */
export function useIsNative(): boolean {
  return useContext(Ctx)?.native ?? false;
}
