import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  createWebBluetoothDgLabTransport,
  DgLabConnectionRegistry,
  type EmbeddedDeviceRuntimeProvider,
} from '@0xnullai/device-runtime';
import { loadDeviceSafety } from '@0xnullai/settings';

/**
 * The single entry point where the native (Tauri) shell injects Bluetooth
 * capability into modules.
 *
 * Web Bluetooth is unavailable on Android; plugin-blec is mandatory.
 * Pre-merge this seam had a different shape in each of the three shells —
 * Agent used `servicesOverrides` + `connectDeviceTauri`, Chat used
 * `deviceClientFactory` + `requestDeviceTauri`, Voice used `transport`.
 *
 * The three seam shapes are preserved verbatim; only the injection point
 * is unified. Not reshaping them is deliberate: Android has no hot update,
 * a botched injection interface mutes all three modules at once, and the
 * broken build lives on users' phones for a long time. Unifying the shapes
 * is low-reward, high-risk — revisit after several device-verified
 * releases.
 *
 * Context instead of prop drilling: the shell lazy-loads modules by route,
 * so props would thread through ModuleSlot / Suspense / ErrorBoundary and
 * every new module would touch the shell again.
 *
 * Every item is optional: absence falls back to the web implementation
 * instead of throwing.
 */

export interface NativeBridge {
  /** Shell-owned optional embedded runtime shared by every product surface. */
  deviceRuntime?: EmbeddedDeviceRuntimeProvider;
  /**
   * The one DG-Lab connection owner for the whole app instance, built by the shell before render.
   * Modules read it through `useDgLabRegistry()`. The per-module seams below stay until each
   * consumer migrates onto it.
   */
  dglab?: DgLabConnectionRegistry;
  /** Agent's injection: service overrides + unified connect flow. Shape mirrors apps/agent AppProps. */
  agent?: {
    servicesOverrides?: unknown;
    connectDevice?: unknown;
  };
  /** Chat's injection: client factory + device picker. */
  chat?: {
    deviceClientFactory?: unknown;
    requestDevice?: unknown;
  };
  /** Voice's injection: the whole transport. */
  voice?: {
    transport?: unknown;
  };
  /** Video's injection: creates the same control service with native BLE clients. */
  video?: {
    createControlService?: unknown;
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
  /** Web also supplies the shared runtime through this seam without pretending to be Tauri. */
  native?: boolean;
}) {
  return <Ctx.Provider value={{ bridge, native }}>{children}</Ctx.Provider>;
}

/** Get shell capabilities. Standalone module builds return an empty object. */
export function useNativeBridge(): NativeBridge {
  return useContext(Ctx)?.bridge ?? EMPTY;
}

/**
 * Canonical reactive view of the shell-owned generic-device opt-in.
 *
 * Surfaces must use this instead of treating an injected runtime as an enabled
 * feature. The provider publishes `false` only after its stop barrier succeeds,
 * so consumers keep their UI and bindings alive when disable fails.
 */
export function useEmbeddedDeviceRuntimeEnabled(): boolean {
  const provider = useNativeBridge().deviceRuntime;
  return useSyncExternalStore(
    (listener) => provider?.subscribeEnabled(listener) ?? NOOP_UNSUBSCRIBE,
    () => provider?.isEnabled() ?? false,
    () => false,
  );
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
const NOOP_UNSUBSCRIBE = () => undefined;

/** Whether the active shell is native rather than Web. */
export function useIsNative(): boolean {
  return useContext(Ctx)?.native ?? false;
}
