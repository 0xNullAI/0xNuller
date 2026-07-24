import { useCallback, useRef, useState } from 'react';
import { BrowserPermissionService, TIMED_PERMISSION_WINDOW_MS } from '@/lib/permissions';
import { PolicyEngine, OpossumPolicyEngine } from '@/lib/policy-engine';
import { createDefaultOpossumPolicyRules, createDefaultPolicyRules } from '@/lib/default-policies';
import { DeviceCommandQueue, OpossumCommandQueue } from '@/lib/device-command-queue';
import { ToolExecutor } from '@/lib/tool-executor';
import { createVoiceToolRegistry } from '@/lib/tool-registry';
import { BrowserWaveformLibrary } from '@/lib/waveform-library';
import type { DeviceSession } from '@/lib/device-session';
import { buildVoiceInstructions } from '@/lib/build-voice-instructions';
import { getAnyPromptPresetById } from '@/lib/prompts';
import { normalizeRealtimeProviderSettings } from '@/lib/realtime/providers';
import { createRealtimeSession } from '@/lib/realtime/realtime-session';
import type { RealtimeSession, RealtimeSessionEvents } from '@/lib/realtime/realtime-session';
import { VoiceToolBridge } from '@/lib/realtime/voice-tool-bridge';
import { CallSafetyGuard } from '@/services/call-safety-guard';
import type { VoiceSettings } from '@/lib/settings';

export type CallStatus = 'idle' | 'connecting' | 'active' | 'ended';

export interface RealtimeCallState {
  status: CallStatus;
  error: string | null;
  speaking: boolean;
  assistantText: string;
  userText: string;
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
 * hangup — including the `CallSafetyGuard` (page-hide/leave => hangup).
 *
 * A fresh `ToolExecutor`/permission grant per call means switching devices
 * or re-authorizing between calls can't leak stale timed grants forward.
 */
export function useRealtimeCall(deviceSession: DeviceSession, settings: VoiceSettings) {
  const [state, setState] = useState<RealtimeCallState>({
    status: 'idle',
    error: null,
    speaking: false,
    assistantText: '',
    userText: '',
  });

  const sessionRef = useRef<RealtimeSession | null>(null);
  const guardStopRef = useRef<(() => void) | null>(null);
  const deviceWatchStopRef = useRef<(() => void) | null>(null);
  const [waveformLibrary] = useState(() => new BrowserWaveformLibrary());

  const hangUp = useCallback(async (reason?: string) => {
    guardStopRef.current?.();
    guardStopRef.current = null;
    deviceWatchStopRef.current?.();
    deviceWatchStopRef.current = null;
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    await deviceSession.emergencyStop();
    setState((prev) => ({ ...prev, status: 'ended', error: reason ?? prev.error, speaking: false }));
  }, [deviceSession]);

  const startCall = useCallback(async () => {
    setState({ status: 'connecting', error: null, speaking: false, assistantText: '', userText: '' });

    const providerSettings = normalizeRealtimeProviderSettings({
      ...settings.providers[settings.activeProviderId],
      providerId: settings.activeProviderId,
    });
    if (!providerSettings.apiKey) {
      setState((prev) => ({ ...prev, status: 'idle', error: '请先在设置里填写当前 provider 的 API Key' }));
      return;
    }

    const context = { sessionId: createSessionId() };
    // One-time pre-call authorization: `timed` mode's first grant is seeded
    // already-valid, so the safety chain never pops a mid-call confirm
    // dialog — the call itself is the user's single up-front authorization.
    const permission = new BrowserPermissionService({
      mode: settings.permissionMode === 'confirm' ? 'timed' : settings.permissionMode,
      timedGrantExpiresAt: Date.now() + TIMED_PERMISSION_WINDOW_MS,
    });

    const registry = createVoiceToolRegistry({ waveformLibrary });
    const executor = new ToolExecutor({
      session: deviceSession,
      registry,
      policyEngine: new PolicyEngine(createDefaultPolicyRules(settings.coyoteSafety)),
      opossumPolicyEngine: new OpossumPolicyEngine(createDefaultOpossumPolicyRules(settings.opossumSafety)),
      permission,
      deviceQueue: new DeviceCommandQueue(deviceSession.coyote),
      opossumQueue: new OpossumCommandQueue(deviceSession.opossum),
      context,
    });

    const events: RealtimeSessionEvents = {
      onOpen: () => setState((prev) => ({ ...prev, status: 'active' })),
      onClose: (reason) =>
        setState((prev) => (prev.status === 'ended' ? prev : { ...prev, status: 'ended', error: reason })),
      onError: (error) => setState((prev) => ({ ...prev, error: error.message })),
      onSpeakingChange: (speaking) => setState((prev) => ({ ...prev, speaking })),
      onAssistantTranscript: (text) => setState((prev) => ({ ...prev, assistantText: text })),
      onUserTranscript: (text) => setState((prev) => ({ ...prev, userText: text })),
    };

    const preset = getAnyPromptPresetById(settings.promptPresetId, settings.savedPromptPresets);
    const buildInstructions = async () =>
      buildVoiceInstructions(preset?.prompt, await deviceSession.getState(), {
        coyoteSafety: settings.coyoteSafety,
        opossumSafety: settings.opossumSafety,
      });

    try {
      const tools = await registry.listDefinitions();
      const session = await createRealtimeSession({
        settings: providerSettings,
        tools,
        instructions: await buildInstructions(),
        events,
      });

      const bridge = new VoiceToolBridge(session, executor);
      Object.assign(events, bridge.attach(events));

      await session.connect();
      sessionRef.current = session;
      guardStopRef.current = new CallSafetyGuard({ onHangup: () => hangUp('页面已离开或切至后台，通话已自动挂断') }).start();

      // Keep the model's [当前设备状态] block current as strength/connection
      // state changes mid-call — debounced so a burst of rapid state changes
      // (e.g. a fast adjust_strength sequence) doesn't flood session.update.
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      deviceWatchStopRef.current = deviceSession.onChanged(() => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void buildInstructions().then((text) => sessionRef.current?.updateInstructions(text));
        }, 1500);
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: 'idle',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [deviceSession, hangUp, settings, waveformLibrary]);

  return { state, startCall, hangUp };
}
