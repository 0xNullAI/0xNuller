import type { SavedPromptPreset } from '@dg-agent/runtime';
import { createEmbeddedAgentClient, type AgentClient } from '@dg-agent/client';
import type {
  DeviceClient,
  PermissionService,
  SessionStore,
  SessionTraceStore,
  WaveformLibrary,
} from '@dg-agent/core';
import { getWebBluetoothAvailability } from '@dg-kit/transport-webbluetooth';
import { BrowserPermissionService } from '@0xnullai/permissions';
import { createBrowserLlmClient } from './create-browser-llm-client.js';
export { formatProviderConfigError, isPiAiProviderKey } from './create-browser-llm-client.js';
import {
  OpossumPolicyEngine,
  PolicyEngine,
  createDefaultOpossumPolicyRules,
  createDefaultPolicyRules,
  createDefaultToolRegistryWithDeps,
  type CivetEdgingClient,
  type OpossumClient,
  type PawPrintsClient,
  type DeviceExecutionGate,
} from '@dg-agent/runtime';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';
import { appendAiDeviceRuntimeStatus, type AiDeviceToolAdapter } from '@0xnullai/device-runtime';
import {
  AGENT_RUNTIME_PERMISSION_TOOL_NAMES,
  DeviceRuntimeToolRegistry,
} from './device-runtime-tool-registry.js';

export interface CreateBrowserAgentClientOptions {
  settings: BrowserAppSettings;
  /**
   * Current scene (persona). Comes from the shared scene library, no longer
   * from the settings blob.
   */
  scenes: { selectedId: string; saved: SavedPromptPreset[] };
  device: DeviceClient;
  /** At most one connected auxiliary device of each kind, alongside Coyote. */
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  waveformLibrary: WaveformLibrary;
  permissionService?: PermissionService;
  /** Optional final boundary check, typically backed by the shell's module lease. */
  deviceExecutionGate?: DeviceExecutionGate;
  /** Optional adapter over the shell-owned shared generic device runtime. */
  deviceRuntimeTools?: AiDeviceToolAdapter;
  /**
   * Shared secret used to sign requests to the free-tier proxy. Only the
   * Tauri Android shell supplies this (via a build-time env var); web
   * builds rely on the proxy's Origin whitelist instead. Ignored unless
   * the active provider is `free`.
   */
  freeProxySecret?: string;
}

export function createBrowserAgentClient(options: CreateBrowserAgentClientOptions): AgentClient {
  const { settings, scenes } = options;
  const llm = createBrowserLlmClient({
    provider: settings.provider,
    temperature: settings.temperature,
    freeProxySecret: options.freeProxySecret,
  });
  const legacyToolRegistry = createDefaultToolRegistryWithDeps({
    waveformLibrary: options.waveformLibrary,
    toolDefinitionHints: {
      maxColdStartStrength: settings.maxColdStartStrength,
      maxAdjustStrengthStep: settings.maxAdjustStrengthStep,
      maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
      maxBurstDurationMs: settings.maxBurstDurationMs,
      maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
      maxVibrateStartIntensity: settings.maxOpossumColdStartIntensity,
      maxVibrateAdjustStep: settings.maxOpossumAdjustStep,
      maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: settings.maxVibrateBurstCallsPerTurn,
    },
  });
  const toolRegistry = options.deviceRuntimeTools
    ? new DeviceRuntimeToolRegistry(legacyToolRegistry, options.deviceRuntimeTools)
    : legacyToolRegistry;
  const buildBaseInstructions = createBuildBrowserInstructions({
    promptPresetId: scenes.selectedId,
    savedPromptPresets: scenes.saved,
    maxStrengthA: settings.maxStrengthA,
    maxStrengthB: settings.maxStrengthB,
    maxOpossumIntensityA: settings.maxOpossumIntensityA,
    maxOpossumIntensityB: settings.maxOpossumIntensityB,
  });

  return createEmbeddedAgentClient({
    device: options.device,
    opossum: options.opossum,
    pawPrints: options.pawPrints,
    civetEdging: options.civetEdging,
    llm,
    toolRegistry,
    deviceExecutionGate: options.deviceExecutionGate,
    permissionRequiredToolNames: options.deviceRuntimeTools
      ? AGENT_RUNTIME_PERMISSION_TOOL_NAMES
      : undefined,
    permission:
      options.permissionService ??
      new BrowserPermissionService({
        mode: settings.permissionMode,
      }),
    policyEngine: new PolicyEngine(
      createDefaultPolicyRules({
        maxStrengthA: settings.maxStrengthA,
        maxStrengthB: settings.maxStrengthB,
        maxColdStartStrength: settings.maxColdStartStrength,
        maxAdjustStep: settings.maxAdjustStrengthStep,
        maxBurstDurationMs: settings.maxBurstDurationMs,
        maxBurstStrengthAbsolute: settings.maxBurstStrengthAbsolute,
        maxBurstStrengthRelative: settings.maxBurstStrengthRelative,
      }),
    ),
    opossumPolicyEngine: new OpossumPolicyEngine(
      createDefaultOpossumPolicyRules({
        maxIntensityA: settings.maxOpossumIntensityA,
        maxIntensityB: settings.maxOpossumIntensityB,
        maxColdStartIntensity: settings.maxOpossumColdStartIntensity,
        maxAdjustStep: settings.maxOpossumAdjustStep,
      }),
    ),
    buildInstructions: (input) =>
      appendAiDeviceRuntimeStatus(
        buildBaseInstructions(input),
        options.deviceRuntimeTools?.snapshot() ?? null,
      ),
    toolCallConfig: {
      maxToolIterations: settings.maxToolIterations,
      maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
      maxAdjustStrengthCallsPerTurn: settings.maxAdjustStrengthCallsPerTurn,
      maxBurstCallsPerTurn: settings.maxBurstCallsPerTurn,
      burstRequiresActiveChannel: settings.burstRequiresActiveChannel,
      maxVibrateAdjustCallsPerTurn: settings.maxVibrateAdjustCallsPerTurn,
      maxVibrateBurstCallsPerTurn: settings.maxVibrateBurstCallsPerTurn,
    },
    sensorTriggerOptions: {
      civetPressureDeltaThresholdKPa: settings.civetPressureDeltaThresholdKPa,
      debounceMs: settings.sensorTriggerDebounceMs,
    },
    modelContextStrategy: settings.modelContextStrategy,
    sessionStore: options.sessionStore,
    sessionTraceStore: options.sessionTraceStore,
    waveformLibrary: options.waveformLibrary,
  });
}

export function describeBrowserModes(
  settings: BrowserAppSettings,
  options: {
    /**
     * Override the bluetoothAvailability probe. Non-browser shells (Tauri
     * Android) supply their own device transport and want the UI to skip the
     * "Web Bluetooth not supported" warning.
     */
    bluetoothAvailabilityOverride?: ReturnType<typeof getWebBluetoothAvailability>;
  } = {},
): {
  deviceMode: 'fake' | 'web-bluetooth';
  llmMode: 'fake' | 'provider-http';
  bluetoothAvailability: ReturnType<typeof getWebBluetoothAvailability>;
  permissionMode: BrowserAppSettings['permissionMode'];
  providerId: BrowserAppSettings['provider']['providerId'];
} {
  const config = settings;

  return {
    deviceMode: config.deviceMode,
    llmMode: config.llmMode,
    permissionMode: config.permissionMode,
    providerId: config.provider.providerId,
    bluetoothAvailability: options.bluetoothAvailabilityOverride ?? getWebBluetoothAvailability(),
  };
}
