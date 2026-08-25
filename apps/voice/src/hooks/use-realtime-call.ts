import { loadScenes } from '@0xnullai/scenes';
import { useCallback, useMemo, useRef, useState } from 'react';
import { BrowserPermissionService } from '@0xnullai/permissions';
import { PolicyEngine, OpossumPolicyEngine, DeviceLifecycleGuard } from '@dg-kit/safety';
import { createDefaultOpossumPolicyRules, createDefaultPolicyRules } from '@dg-kit/safety';
import { DeviceCommandQueue, OpossumCommandQueue } from '@dg-kit/safety';
import { ToolExecutor } from '@voice/lib/tool-executor';
import { createVoiceToolRegistry } from '@voice/lib/tool-registry';
import { BrowserWaveformLibrary } from '@voice/lib/waveform-library';
import type { DeviceSession } from '@voice/lib/device-session';
import { buildVoiceInstructions } from '@voice/lib/build-voice-instructions';
import { getAnyPromptPresetById } from '@voice/lib/prompts';
import { normalizeRealtimeProviderSettings } from '@voice/lib/realtime/providers';
import { createRealtimeSession } from '@voice/lib/realtime/realtime-session';
import type {
  RealtimeSession,
  RealtimeSessionEvents,
  RealtimeTranscriptEntry,
} from '@voice/lib/realtime/realtime-session';
import { VoiceToolBridge } from '@voice/lib/realtime/voice-tool-bridge';
import type { VoiceSettings } from '@voice/lib/settings';
import type { ActionContext, PermissionDecision, PermissionRequest } from '@dg-kit/safety';
import {
  appendAiDeviceRuntimeStatus,
  createAiDeviceToolAdapter,
  createDeviceInteractionId,
  type EmbeddedDeviceRuntimeProvider,
} from '@0xnullai/device-runtime';
import {
  listVoiceToolDefinitions,
  voiceToolAvailability,
  VoiceCompositeToolExecutor,
} from '@voice/lib/device-runtime-tools';

export interface PendingPermissionRequest {
  input: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export type CallStatus = 'idle' | 'connecting' | 'active' | 'ended';

export interface RealtimeCallState {
  status: CallStatus;
  error: string | null;
  speaking: boolean;
  /** Full running conversation, appended to as turns complete — not just the latest line. */
  transcript: RealtimeTranscriptEntry[];
  /** `Date.now()` timestamp when the call became active — drives the elapsed-time display in `CallPanel`. */
  startedAt: number | null;
}

function createSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Owns one call's lifecycle: builds a fresh safety chain (policy engines,
 * queues, permission service, tool executor) scoped to this call, connects
 * the realtime session, wires the tool bridge, and tears everything down on
 * hangup — including the shared DeviceLifecycleGuard (page-hide/leave => hangup).
 *
 * A fresh `ToolExecutor`/permission grant per call means switching devices
 * or re-authorizing between calls can't leak stale timed grants forward.
 */
export function useRealtimeCall(
  deviceSession: DeviceSession,
  settings: VoiceSettings,
  deviceRuntimeProvider?: EmbeddedDeviceRuntimeProvider,
) {
  const [state, setState] = useState<RealtimeCallState>({
    status: 'idle',
    error: null,
    speaking: false,
    transcript: [],
    startedAt: null,
  });

  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null);
  const pendingPermissionRef = useRef<PendingPermissionRequest | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const guardStopRef = useRef<(() => void) | null>(null);
  const deviceWatchStopRef = useRef<(() => void) | null>(null);
  const [waveformLibrary] = useState(() => new BrowserWaveformLibrary());
  const runtimeTools = useMemo(
    () =>
      deviceRuntimeProvider ? createAiDeviceToolAdapter(deviceRuntimeProvider, 'voice') : undefined,
    [deviceRuntimeProvider],
  );

  const resolvePermission = useCallback((decision: PermissionDecision) => {
    const pending = pendingPermissionRef.current;
    pendingPermissionRef.current = null;
    setPendingPermission(null);
    pending?.resolve(decision);
  }, []);

  const hangUp = useCallback(
    async (_reason?: string) => {
      // A dialog still on screen when the call ends must not leave its promise
      // dangling — the tool executor would await it forever.
      const stranded = pendingPermissionRef.current;
      pendingPermissionRef.current = null;
      setPendingPermission(null);
      stranded?.resolve({ type: 'deny', reason: '通话已结束' });

      guardStopRef.current?.();
      guardStopRef.current = null;
      deviceWatchStopRef.current?.();
      deviceWatchStopRef.current = null;
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      const genericRuntime = deviceRuntimeProvider?.current();
      const stops: Promise<unknown>[] = [
        Promise.resolve().then(() => deviceSession.emergencyStop()),
      ];
      if (genericRuntime) {
        stops.push(
          Promise.resolve().then(() =>
            genericRuntime.forModule('voice').actions.emergencyStop({
              interactionId: createDeviceInteractionId('voice', 'hangup'),
            }),
          ),
        );
      }
      const stopResults = await Promise.allSettled(stops);
      const stopFailed = stopResults.some(
        (result) =>
          result.status === 'rejected' ||
          (result.value !== null &&
            typeof result.value === 'object' &&
            'status' in result.value &&
            result.value.status === 'faulted'),
      );
      setState((prev) => ({
        ...prev,
        status: 'ended',
        error: stopFailed ? '无法确认设备已停止，请立即断开设备或取下设备' : null,
        speaking: false,
      }));
    },
    [deviceRuntimeProvider, deviceSession],
  );

  const startCall = useCallback(async () => {
    setState({
      status: 'connecting',
      error: null,
      speaking: false,
      transcript: [],
      startedAt: null,
    });

    const providerSettings = normalizeRealtimeProviderSettings({
      ...settings.providers[settings.activeProviderId],
      providerId: settings.activeProviderId,
    });
    if (!providerSettings.apiKey) {
      setState((prev) => ({
        ...prev,
        status: 'idle',
        error: '请先配置当前语音服务的 API Key',
      }));
      return;
    }

    // ActionContext now comes from @dg-kit/safety (the same contract DG-Agent
    // uses). DG-Voice is a web client, so sourceType is honestly 'web'; traceId
    // is what threads every device command from this one call together in the
    // logs.
    const sessionId = createSessionId();
    const context: ActionContext = {
      sessionId,
      sourceType: 'web',
      traceId: `voice-${sessionId}`,
    };
    // Honor `permissionMode` exactly as the user set it. This previously
    // silently rewrote 'confirm' (the strictest option AND the default) to
    // 'timed' and pre-seeded the timed grant as already-valid, so no
    // confirmation prompt could ever appear in any mode — the setting was
    // decorative while its label claimed "最严格". A comment described this
    // as "one-time pre-call authorization", but no such authorization step
    // ever existed; consent was simply skipped. Do not reintroduce a
    // pre-seeded grant here: if a smoother in-call flow is wanted, it has
    // to be an actual consent gate the user passes through, not an
    // assumption made on their behalf.
    const permission = new BrowserPermissionService({
      mode: settings.permissionMode,
      // Same four-scope modal DG-Agent uses, instead of a native
      // `window.confirm` (which blocks the whole tab and can't show the
      // tool arguments).
      requestFn: (input) =>
        new Promise<PermissionDecision>((resolve) => {
          const pending = { input, resolve };
          pendingPermissionRef.current = pending;
          setPendingPermission(pending);
        }),
    });

    const registry = createVoiceToolRegistry({ waveformLibrary });
    const legacyExecutor = new ToolExecutor({
      session: deviceSession,
      registry,
      policyEngine: new PolicyEngine(createDefaultPolicyRules(settings.coyoteSafety)),
      opossumPolicyEngine: new OpossumPolicyEngine(
        createDefaultOpossumPolicyRules(settings.opossumSafety),
      ),
      permission,
      deviceQueue: new DeviceCommandQueue(deviceSession.coyote),
      opossumQueue: new OpossumCommandQueue(deviceSession.opossum),
      context,
    });

    const events: RealtimeSessionEvents = {
      onOpen: () => setState((prev) => ({ ...prev, status: 'active', startedAt: Date.now() })),
      onClose: (reason) =>
        setState((prev) =>
          prev.status === 'ended' ? prev : { ...prev, status: 'ended', error: reason },
        ),
      onError: (error) =>
        setState((prev) => ({ ...prev, error: `服务端返回错误：${error.message}` })),
      onSpeakingChange: (speaking) => setState((prev) => ({ ...prev, speaking })),
      onTranscript: (entry) =>
        setState((prev) => {
          // Keyed by the provider's item_id so streaming deltas update the
          // same line in place, while a genuinely new turn appends.
          const index = prev.transcript.findIndex((item) => item.id === entry.id);
          const transcript =
            index === -1
              ? [...prev.transcript, entry]
              : prev.transcript.map((item, i) => (i === index ? entry : item));
          return { ...prev, transcript };
        }),
    };

    // Scenes come from the cross-module shared library, not from VoiceSettings
    // any more — a persona written in Agent is usable here too.
    const sceneLib = loadScenes();
    const preset = getAnyPromptPresetById(sceneLib.selectedId, sceneLib.scenes);
    const buildConfiguration = async () => {
      const deviceState = await deviceSession.getState();
      const availability = voiceToolAvailability(
        deviceState,
        runtimeTools,
        deviceRuntimeProvider?.isEnabled() ?? false,
      );
      const runtimeSnapshot = availability.generic ? (runtimeTools?.snapshot() ?? null) : null;
      const instructions = appendAiDeviceRuntimeStatus(
        buildVoiceInstructions(preset?.prompt, deviceState, {
          coyoteSafety: settings.coyoteSafety,
          opossumSafety: settings.opossumSafety,
        }),
        runtimeSnapshot,
      );
      return {
        instructions,
        tools: await listVoiceToolDefinitions(registry, availability, runtimeTools),
        topologyKey: JSON.stringify({
          coyote: availability.coyote,
          opossum: availability.opossum,
          genericSessionId: runtimeSnapshot?.sessionId ?? null,
          genericTopologyGeneration: runtimeSnapshot?.topologyGeneration ?? null,
          genericTargets:
            runtimeSnapshot?.devices.flatMap((device) =>
              device.capabilities
                .filter((capability) => capability.kind === 'vibrate' && !capability.faulted)
                .map((capability) => [device.deviceId, capability.featureId]),
            ) ?? [],
        }),
      };
    };
    const executor = new VoiceCompositeToolExecutor({
      legacy: legacyExecutor,
      runtime: runtimeTools,
      permission,
      context,
      onRuntimeToolComplete: async () => {
        const current = sessionRef.current;
        if (current) current.updateConfiguration(await buildConfiguration());
      },
    });

    try {
      const initialConfiguration = await buildConfiguration();
      const session = await createRealtimeSession({
        settings: providerSettings,
        tools: initialConfiguration.tools,
        instructions: initialConfiguration.instructions,
        events,
      });

      const bridge = new VoiceToolBridge(session, executor);
      Object.assign(events, bridge.attach(events));

      await session.connect();
      sessionRef.current = session;
      guardStopRef.current = new DeviceLifecycleGuard({
        onStop: () => hangUp('页面已离开或切至后台，通话已自动挂断'),
      }).start();

      // Keep both the status text and tool allowlist synchronized. Every
      // supported dialect sends both fields in session.update, so a device
      // disconnect removes its tools instead of relying on execution-time
      // rejection alone.
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      let refreshRevision = 0;
      let currentTopologyKey = initialConfiguration.topologyKey;
      let runtimeSnapshotStop: (() => void) | null = null;
      let watchedRuntime = deviceRuntimeProvider?.current() ?? null;
      const refresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        const revision = ++refreshRevision;
        void buildConfiguration().then((configuration) => {
          if (revision !== refreshRevision) return;
          if (configuration.topologyKey !== currentTopologyKey) {
            currentTopologyKey = configuration.topologyKey;
            sessionRef.current?.updateConfiguration(configuration);
            return;
          }
          refreshTimer = setTimeout(
            () => sessionRef.current?.updateConfiguration(configuration),
            1500,
          );
        });
      };
      const bindRuntimeSnapshot = () => {
        const current = deviceRuntimeProvider?.current() ?? null;
        if (current === watchedRuntime && runtimeSnapshotStop) return;
        runtimeSnapshotStop?.();
        runtimeSnapshotStop = null;
        watchedRuntime = current;
        if (current) runtimeSnapshotStop = current.manager.subscribe(refresh);
      };
      bindRuntimeSnapshot();
      const stopLegacyWatch = deviceSession.onChanged(refresh);
      const stopEnabledWatch = deviceRuntimeProvider?.subscribeEnabled(() => {
        bindRuntimeSnapshot();
        refresh();
      });
      deviceWatchStopRef.current = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        stopLegacyWatch();
        stopEnabledWatch?.();
        runtimeSnapshotStop?.();
      };
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: 'idle',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [deviceSession, hangUp, runtimeTools, settings, waveformLibrary]);

  return { state, startCall, hangUp, pendingPermission, resolvePermission };
}
