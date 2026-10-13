import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { deviceConversationAccess } from '@0xnullai/settings';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
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

/**
 * Settings that only drive this page's own UI. Nothing in the runtime, bridge, permission or
 * speech services reads them, so changing one must not rebuild the runtime (which aborts the
 * running reply and stops every output). Anything not listed here rebuilds — new settings fail
 * safe by default.
 */
const UI_ONLY_SETTINGS = [
  'showSafetyNoticeOnStartup',
  'safetyStopOnLeave',
  'rememberApiKey',
  'modelLogEnabled',
  'speechRecognitionEnabled',
  'speechSynthesisEnabled',
  'providerConfigs',
] as const satisfies ReadonlyArray<keyof BrowserAppSettings>;

/** Value identity of the settings the services are built from. */
export function runtimeSettingsKey(settings: BrowserAppSettings): string {
  const relevant: Partial<BrowserAppSettings> = { ...settings };
  for (const key of UI_ONLY_SETTINGS) delete relevant[key];
  return JSON.stringify(relevant);
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

  const [accountId, setAccountId] = useState(currentAuthUserId);
  useEffect(() => subscribeAuthChanges(() => setAccountId(currentAuthUserId())), []);

  // Rebuilding the runtime disposes it, which aborts the running reply and stops every output.
  // So settings count by value, not identity (the settings stores hand out fresh objects on
  // every sync), and scenes are read through a getter at each turn instead of being a
  // rebuild trigger at all.
  const settingsKey = useMemo(() => runtimeSettingsKey(settings), [settings]);
  const [runtimeSettings, setRuntimeSettings] = useState(settings);
  if (runtimeSettingsKey(runtimeSettings) !== settingsKey) setRuntimeSettings(settings);
  const scenesRef = useRef(scenes);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);
  const disableSpeech = servicesOverrides?.disableSpeech;
  const disableBridge = servicesOverrides?.disableBridge;

  // Rebuild only the runtime on identity changes; shell-owned physical clients remain stable.
  const services = useMemo(
    () =>
      createBrowserServices({
        settings: runtimeSettings,
        scenes: () => scenesRef.current,
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
        ...(disableSpeech === undefined ? {} : { disableSpeech }),
        ...(disableBridge === undefined ? {} : { disableBridge }),
        // On Android the registry's transport is native BLE; the Web Bluetooth probe does not apply.
        ...(nativeBluetooth ? { bluetoothAvailabilityOverride: { supported: true } } : {}),
      }),
    // accountId is a deliberate trigger: each account gets a fresh runtime and session store.
    [
      runtimeSettings,
      accountId,
      inShell,
      device,
      opossum,
      pawPrints,
      civetEdging,
      resolveBridgeSessionId,
      setPendingPermission,
      disableSpeech,
      disableBridge,
      nativeBluetooth,
      taskRunReporter,
    ],
  );

  // Release the previous AgentRuntime (device listener, in-flight turns,
  // scheduled timers) when a real settings or account change builds a new
  // services bundle, so listeners on the shared device don't accumulate.
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
