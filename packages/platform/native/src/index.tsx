import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { WebEmbeddedDeviceRuntimeProvider } from '@0xnullai/device-runtime';

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
  /** Shell-owned optional embedded runtime shared by all modules. */
  deviceRuntime?: WebEmbeddedDeviceRuntimeProvider;
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

const EMPTY: NativeBridge = {};

/** Whether the active shell is native rather than Web. */
export function useIsNative(): boolean {
  return useContext(Ctx)?.native ?? false;
}
