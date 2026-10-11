import type { SavedScene } from '@0xnullai/scenes';
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
export { formatProviderConfigError } from './create-browser-llm-client.js';
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
  type RuntimeTaskRunReporter,
} from '@dg-agent/runtime';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';
import { createPrivateAgentTools } from './private-agent-tools.js';
import { loadPrivateConversationContext } from './private-context.js';
import { supportsCharacterMemory } from './character-memory-eligibility.js';
import { CoyoteTargetToolRegistry, createCoyoteTargetRouter } from './coyote-target-routing.js';

export interface CreateBrowserAgentClientOptions {
  settings: BrowserAppSettings;
  /** Explicitly enable account-private relationship/memory only in the owner's personal Agent UI. */
  allowPersonalContext?: boolean;
  /**
   * Current scene (persona). Comes from the shared scene library, no longer
   * from the settings blob.
   */
  scenes: { selectedId: string; saved: SavedScene[] };
  device: DeviceClient;
  /** At most one connected auxiliary device of each kind, alongside Coyote. */
  opossum?: OpossumClient;
  pawPrints?: PawPrintsClient;
  civetEdging?: CivetEdgingClient;
  sessionStore?: SessionStore;
  sessionTraceStore?: SessionTraceStore;
  /** Optional server TaskRun reporter for explicit, server-owned conversations. */
  taskRunReporter?: RuntimeTaskRunReporter;
  waveformLibrary: WaveformLibrary;
  permissionService?: PermissionService;
  /** Optional final boundary check, typically backed by the shell's module lease. */
  deviceExecutionGate?: DeviceExecutionGate;
}

export function createBrowserAgentClient(options: CreateBrowserAgentClientOptions): AgentClient {
  const { settings, scenes } = options;
  const characterForPrivateMemory = (presetId: string): boolean =>
    supportsCharacterMemory(presetId, scenes.saved);
  const llm = createBrowserLlmClient({
    provider: settings.provider,
    temperature: settings.temperature,
    attachPrivateConversation: options.allowPersonalContext === true,
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
  const coyoteTargetRouter = createCoyoteTargetRouter(options.device);
  const toolRegistry = new CoyoteTargetToolRegistry(legacyToolRegistry, coyoteTargetRouter);
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
    coyoteTargetRouter,
    opossum: options.opossum,
    pawPrints: options.pawPrints,
    civetEdging: options.civetEdging,
    llm,
    toolRegistry,
    contextualTools: options.allowPersonalContext
      ? createPrivateAgentTools({
          allowCharacterMemory: (session) =>
            characterForPrivateMemory(
              typeof session.metadata?.promptPresetId === 'string'
                ? session.metadata.promptPresetId
                : scenes.selectedId,
            ),
        })
      : undefined,
    deviceExecutionGate: options.deviceExecutionGate,
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
    buildInstructions: async (input) => {
      const characterId =
        typeof input.session.metadata?.promptPresetId === 'string' &&
        input.session.metadata.promptPresetId
          ? input.session.metadata.promptPresetId
          : scenes.selectedId;
      const privateContext = await loadPrivateConversationContext({
        enabled: options.allowPersonalContext === true && characterForPrivateMemory(characterId),
        characterId,
        context: input.context,
        session: input.session,
      });
      return [buildBaseInstructions(input), privateContext].filter(Boolean).join('\n\n');
    },
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
    taskRunReporter: options.taskRunReporter,
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
