import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { deviceConversationAccess } from '@0xnullai/settings';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  createBrowserServices,
  createRegistryAgentDevices,
  type BrowserServices,
  type BrowserServicesOptions,
  type DgLabModuleHandle,
  type PermissionRequestInput,
} from '@dg-agent/agent-browser';
import type { MessageOrigin } from '@dg-agent/bridge';
import type { PermissionDecision } from '@dg-agent/core';
import { currentDeviceLease, hasDeviceLease } from '@dg-kit/safety';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import type { SavedScene } from '@0xnullai/scenes';
import { BrowserUpdateChecker } from '../services/update-checker.js';
import { createAgentTaskRunReporter } from '../services/agent-task-run-reporter.js';

export interface PendingPermissionRequest {
  input: PermissionRequestInput;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Non-device service flags a non-browser shell (Tauri Android) may supply. Web omits them.
 * Device clients always come from the shared DG-Lab registry, never from an override.
 */
export type ServicesOverrides = Pick<BrowserServicesOptions, 'disableSpeech' | 'disableBridge'> & {
  /** Skip the update-checker poll loop (no version.json on non-web shells). */
  disableUpdateChecker?: boolean;
};

export interface UseBrowserAppServicesOptions {
  settings: BrowserAppSettings;
  inShell?: boolean;
  /** The current scene (persona). Comes from the shared scene library. */
  scenes: { selectedId: string; saved: SavedScene[] };
  setPendingPermission: Dispatch<SetStateAction<PendingPermissionRequest | null>>;
  resolveBridgeSessionId: (origin: MessageOrigin) => string | null | Promise<string | null>;
  servicesOverrides?: ServicesOverrides;
  /** Agent's handle on the app's one DG-Lab registry. Every device client comes from it. */
  dglab: DgLabModuleHandle;
  /** The registry's transport is native BLE, so the Web Bluetooth probe does not apply. */
  nativeBluetooth?: boolean;
}

export interface UseBrowserAppServicesResult extends BrowserServices {
  updateChecker: BrowserUpdateChecker;
  serviceInitWarnings: string[];
}

export function useBrowserAppServices(
  options: UseBrowserAppServicesOptions,
): UseBrowserAppServicesResult {
  const {
    resolveBridgeSessionId,
    settings,
    scenes,
    setPendingPermission,
    servicesOverrides,
    dglab,
    nativeBluetooth = false,
    inShell = false,
  } = options;

  const disableUpdateChecker = servicesOverrides?.disableUpdateChecker ?? false;
  const updateChecker = useMemo(
    () =>
      new BrowserUpdateChecker({
        currentBuildId: __BUILD_ID__,
        versionUrl: `${import.meta.env.BASE_URL}version.json`,
        disabled: disableUpdateChecker,
      }),
    [disableUpdateChecker],
  );

  // The clients own no BLE link (the registry does), so building them once is only about
  // keeping runtime listeners stable across settings-driven service rebuilds. The registry
  // handle is shell-lifetime.
  const [{ device, opossum, pawPrints, civetEdging }] = useState(() =>
    createRegistryAgentDevices(dglab),
  );
  const taskRunReporter = useMemo(() => createAgentTaskRunReporter(), []);

  const { disableUpdateChecker: _disableUpdateChecker, ...browserServicesOverrides } =
    servicesOverrides ?? {};
  // The registry's transport is native BLE on Android, so the Web Bluetooth probe does not apply.
  const deviceOverrides: Pick<BrowserServicesOptions, 'bluetoothAvailabilityOverride'> =
    nativeBluetooth ? { bluetoothAvailabilityOverride: { supported: true } } : {};

  const [accountId, setAccountId] = useState(currentAuthUserId);
  useEffect(() => subscribeAuthChanges(() => setAccountId(currentAuthUserId())), []);
  // Rebuild only the runtime on identity changes; shell-owned physical clients remain stable.
  const services = useMemo(
    () =>
      createBrowserServices({
        settings,
        scenes,
        device,
        opossum,
        pawPrints,
        civetEdging,
        // A standalone build has no shell lease holder; inside the shell a
        // different holder must block every non-stop command at the boundary.
        deviceExecutionGate: ({ sessionId, context }) =>
          (inShell
            ? hasDeviceLease('agent')
            : currentDeviceLease() === null || hasDeviceLease('agent')) &&
          (context.sourceType === 'sensor' ||
            deviceConversationAccess(currentAuthUserId(), 'ai', sessionId)),
        taskRunReporter,
        resolveBridgeSessionId,
        onPermissionRequest: (input) =>
          new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({ input, resolve });
          }),
        ...browserServicesOverrides,
        ...deviceOverrides,
      }),
    [
      settings,
      accountId,
      inShell,
      scenes.selectedId,
      scenes.saved,
      device,
      opossum,
      pawPrints,
      civetEdging,
      resolveBridgeSessionId,
      setPendingPermission,
      servicesOverrides,
      nativeBluetooth,
      taskRunReporter,
    ],
  );

  // Release the previous AgentRuntime (device listener, in-flight turns,
  // scheduled timers) when settings cause a new services bundle to be built,
  // so listeners on the shared device don't accumulate.
  useEffect(() => {
    return () => {
      services.client.dispose?.();
    };
  }, [services]);

  return {
    ...services,
    updateChecker,
    serviceInitWarnings: services.warnings,
  };
}
