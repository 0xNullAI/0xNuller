import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

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
}

const Ctx = createContext<NativeBridge | null>(null);

export function NativeBridgeProvider({
  bridge,
  children,
}: {
  bridge: NativeBridge;
  children: ReactNode;
}) {
  return <Ctx.Provider value={bridge}>{children}</Ctx.Provider>;
}

/** Get native capabilities. The web build returns an empty object — callers must treat every field as optional. */
export function useNativeBridge(): NativeBridge {
  return useContext(Ctx) ?? EMPTY;
}

const EMPTY: NativeBridge = {};

/**
 * Whether we run inside the native shell.
 *
 * Used for copy differences, e.g. the settings note "mobile always stops
 * output regardless of this setting" — Android lifecycle safety is
 * unconditional and deliberately overrides user preference.
 */
export function useIsNative(): boolean {
  return useContext(Ctx) !== null;
}
