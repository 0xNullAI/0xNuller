import {
  NULL_SPEECH_CAPABILITIES,
  createNullSpeechRecognitionController,
  createNullSpeechSynthesizer,
  createSpeechRecognitionController,
  createSpeechSynthesizer,
  getBrowserSpeechCapabilities,
} from '@dg-agent/audio-browser';
import {
  BridgeAdapterRegistry,
  BridgeManager,
  BridgePermissionService,
  createBrowserBridgeAdapters,
  type MessageOrigin,
} from '@dg-agent/bridge';
import type { AgentClient } from '@dg-agent/client';
import type {
  DeviceClient,
  PermissionDecision,
  RuntimeEvent,
  RuntimeTraceEntry,
  SessionSnapshot,
} from '@dg-agent/core';
import type { CivetPressureReading, PawPrintsReading } from '@dg-kit/protocol';
import { BrowserPermissionService } from '@0xnullai/permissions';
import type {
  CivetEdgingClient,
  OpossumClient,
  PawPrintsClient,
  SavedPromptPreset,
  DeviceExecutionGate,
  RuntimeTaskRunReporter,
} from '@dg-agent/runtime';
import {
  ServerSessionStore,
  TransientSessionTraceStore,
  type BrowserAppSettings,
} from '@dg-agent/storage-browser';
import { BrowserWaveformLibrary } from '@dg-agent/waveforms';
import { createBrowserAgentClient, describeBrowserModes } from './create-browser-agent-client.js';
import {
  RegistryCoyoteClient,
  RegistryOpossumClient,
  RegistrySensorClient,
  type DgLabModuleHandle,
} from '@0xnullai/device-runtime';

export type { DgLabModuleHandle } from '@0xnullai/device-runtime';

/** The module id the shell grants the device lease to while Agent is visible. */
export const AGENT_DEVICE_MODULE_ID = 'agent';

export interface RegistryAgentDevices {
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
}

/**
 * Agent's device clients over the shell's one DG-Lab registry.
 *
 * They own no BLE link: a Coyote connected on 设备 is the same physical device the AI chat sees,
 * and every output write is lease-fenced and re-clamped by the registry. The Coyote client keeps
 * the exact-target surface (`getConnectedCoyotes`, `executeDeviceById`, …) that
 * `createCoyoteTargetRouter` needs, so each tool call still names one opaque target id.
 */
export function createRegistryAgentDevices(handle: DgLabModuleHandle): RegistryAgentDevices {
  return {
    device: new RegistryCoyoteClient(handle),
    opossum: new RegistryOpossumClient(handle),
    pawPrints: new RegistrySensorClient<PawPrintsReading>(handle, 'paw-prints'),
    civetEdging: new RegistrySensorClient<CivetPressureReading>(handle, 'civet-edging'),
  };
}

export interface PermissionRequestInput {
  toolName: string;
  toolDisplayName?: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface BrowserServicesOptions {
  settings: BrowserAppSettings;
  /**
   * Current scene (persona). **No longer read from settings** — the scene
   * library moved to the cross-module shared `@0xnullai/scenes`, so it no
   * longer lives in the same blob as the strength cap (one validation failure
   * anywhere in that blob would silently reset every safety setting). The
   * caller reads it from the shared library and passes it in.
   */
  scenes: { selectedId: string; saved: SavedPromptPreset[] };
  onPermissionRequest: (input: PermissionRequestInput) => Promise<PermissionDecision>;
  resolveBridgeSessionId: (origin: MessageOrigin) => string | null | Promise<string | null>;
  /**
   * Device clients over the app's shared DG-Lab registry (`createRegistryAgentDevices`). The
   * caller builds them once and holds them stable across settings-driven service rebuilds; they
   * own no BLE link, the registry does.
   */
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
  /** Optional final boundary check, typically backed by the shell's module lease. */
  deviceExecutionGate?: DeviceExecutionGate;
  /** Server TaskRun reporter; non-stop tools fail closed without a server run ID. */
  taskRunReporter?: RuntimeTaskRunReporter;
  /**
   * If true, speech recognition / synthesis are stubbed with no-op controllers
   * and capabilities report nothing supported. Used by shells (Android WebView)
   * that lack Web Speech APIs.
   */
  disableSpeech?: boolean;
  /**
   * If true, the BridgeManager is constructed without any adapters, so QQ /
   * Telegram bridges are silently disabled. Used by shells that intentionally
   * ship without bridge integrations.
   */
  disableBridge?: boolean;
  /**
   * Replaces the Web Bluetooth probe. A shell whose registry brings a native BLE transport sets
   * it, so the UI does not warn that this WebView lacks Web Bluetooth.
   */
  bluetoothAvailabilityOverride?: ReturnType<typeof describeBrowserModes>['bluetoothAvailability'];
}

export interface BrowserServices {
  client: AgentClient;
  device: DeviceClient;
  opossum: OpossumClient;
  pawPrints: PawPrintsClient;
  civetEdging: CivetEdgingClient;
  bridgeManager: BridgeManager;
  waveformLibrary: BrowserWaveformLibrary;
  speechRecognition: ReturnType<typeof createSpeechRecognitionController>;
  speechSynthesizer: ReturnType<typeof createSpeechSynthesizer>;
  speechCapabilities: ReturnType<typeof getBrowserSpeechCapabilities>;
  modes: ReturnType<typeof describeBrowserModes>;
  resetPermissionGrants: () => void;
  warnings: string[];
}

class UnavailableAgentClient implements AgentClient {
  readonly transport = 'embedded' as const;
  readonly supportsLiveEvents = false;
  readonly capabilities = { imageInput: false };

  constructor(private readonly message: string) {}

  listSessions(): Promise<SessionSnapshot[]> {
    return Promise.resolve([]);
  }

  searchSessions(_query: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  getSessionMessagesPage(_sessionId: string, _before?: number) {
    return Promise.resolve({ items: [], nextBefore: null });
  }

  getSessionSnapshot(_sessionId: string): Promise<SessionSnapshot> {
    return Promise.reject(new Error(this.message));
  }

  getSessionDisplaySnapshot(_sessionId: string): Promise<SessionSnapshot> {
    return Promise.reject(new Error(this.message));
  }

  getSessionExportSnapshot(_sessionId: string): Promise<SessionSnapshot> {
    return Promise.reject(new Error(this.message));
  }

  getSessionTrace(_sessionId: string): Promise<RuntimeTraceEntry[]> {
    return Promise.resolve([]);
  }

  importSessions(_sessions: SessionSnapshot[]): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  renameSession(_sessionId: string, _title: string | null): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  setSessionScene(_sessionId: string, _sceneId: string | null): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  deleteSession(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  connectDevice(_sessionId?: string): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  disconnectDevice(): Promise<void> {
    return Promise.resolve();
  }

  setSensorTriggersEnabled(_sessionId: string, _enabled: boolean): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  setDeviceLinkRule(): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  getDeviceLinkRule(): null {
    return null;
  }

  isSensorTriggersEnabledForSession(_sessionId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  emergencyStop(_sessionId: string): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  releaseDeviceControl(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  abortCurrentReply(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  sendUserMessage(): Promise<void> {
    return Promise.reject(new Error(this.message));
  }

  subscribe(_listener: (event: RuntimeEvent) => void): () => void {
    return () => undefined;
  }
}

function formatInitError(prefix: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `${prefix}：${error.message}`;
  }
  return `${prefix}，请检查相关设置`;
}

export function createBrowserServices(options: BrowserServicesOptions): BrowserServices {
  const { settings, scenes, onPermissionRequest, resolveBridgeSessionId } = options;

  const warnings: string[] = [];

  const sessionStore = new ServerSessionStore();
  const sessionTraceStore = new TransientSessionTraceStore();
  const waveformLibrary = new BrowserWaveformLibrary();
  const bridgeRegistry = new BridgeAdapterRegistry();
  const { device, opossum, pawPrints, civetEdging } = options;

  const speechRecognition = options.disableSpeech
    ? createNullSpeechRecognitionController()
    : createSpeechRecognitionController({
        lang: settings.speechRecognitionLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        autoStopEnabled: settings.voice.autoStopEnabled,
      });
  const speechSynthesizer = options.disableSpeech
    ? createNullSpeechSynthesizer()
    : createSpeechSynthesizer({
        lang: settings.speechSynthesisLanguage,
        mode: settings.voice.mode,
        proxyUrl: settings.voice.proxyUrl,
        apiKey: settings.voice.apiKey,
        speaker: settings.voice.speaker,
        browserVoiceUri: settings.voice.browserVoiceUri,
      });
  const speechCapabilities = options.disableSpeech
    ? NULL_SPEECH_CAPABILITIES
    : getBrowserSpeechCapabilities({
        recognitionMode: settings.voice.mode,
        synthesisMode: settings.voice.mode,
      });

  const localPermissionService = new BrowserPermissionService({
    mode: settings.permissionMode,
    timedGrantExpiresAt: settings.permissionModeExpiresAt,
    requestFn: (input) =>
      onPermissionRequest({
        toolName: input.toolName,
        toolDisplayName: input.toolDisplayName,
        summary: input.summary,
        args: input.args,
      }),
  });
  const bridgePermissionService = new BridgePermissionService({
    settings: settings.bridge,
    fallback: localPermissionService,
    registry: bridgeRegistry,
  });

  let client: AgentClient;
  try {
    client = createBrowserAgentClient({
      settings,
      allowPersonalContext: true,
      scenes,
      device,
      opossum,
      pawPrints,
      civetEdging,
      sessionStore,
      sessionTraceStore,
      waveformLibrary,
      permissionService: bridgePermissionService,
      deviceExecutionGate: options.deviceExecutionGate,
      taskRunReporter: options.taskRunReporter,
    });
  } catch (error) {
    const message = formatInitError('模型服务初始化失败', error);
    warnings.push(message);
    client = new UnavailableAgentClient(message);
  }

  let bridgeManager: BridgeManager;
  if (options.disableBridge) {
    bridgeManager = new BridgeManager({
      client,
      registry: bridgeRegistry,
      adapters: [],
      resolveTargetSessionId: resolveBridgeSessionId,
    });
  } else {
    try {
      bridgeManager = new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: createBrowserBridgeAdapters(settings.bridge),
        resolveTargetSessionId: resolveBridgeSessionId,
      });
    } catch (error) {
      warnings.push(formatInitError('桥接服务初始化失败', error));
      bridgeManager = new BridgeManager({
        client,
        registry: bridgeRegistry,
        adapters: [],
        resolveTargetSessionId: resolveBridgeSessionId,
      });
    }
  }

  const disposeClient = client.dispose?.bind(client);
  client.dispose = () => {
    sessionStore.dispose();
    disposeClient?.();
  };

  return {
    client,
    device,
    opossum,
    pawPrints,
    civetEdging,
    bridgeManager,
    waveformLibrary,
    speechRecognition,
    speechSynthesizer,
    speechCapabilities,
    modes: describeBrowserModes(settings, {
      bluetoothAvailabilityOverride: options.bluetoothAvailabilityOverride,
    }),
    resetPermissionGrants: () => bridgePermissionService.clearGrants(),
    warnings,
  };
}
