import {
  currentAuthUserId,
  consumeAgentInboxSelection,
  subscribeAuthChanges,
  subscribeAgentInboxSelection,
  readPrivateConversationSelection,
  selectPrivateConversation,
  startAgentRun,
  listAgentRuns,
  getAgentRun,
  finishAgentRun,
  listMediaCapabilities,
  type AgentRunCall,
  type AgentRunStatus,
} from '@0xnullai/auth';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { type MessageOrigin } from '@dg-agent/bridge';
import {
  createEmptyDeviceState,
  createEmptySensorState,
  type DeviceClient,
  type DeviceKind,
  type DeviceState,
  type LlmImageInput,
  type PermissionDecision,
  type DeviceLinkRule,
  DEFAULT_DEVICE_LINK_RULE,
} from '@dg-agent/core';
import { AGENT_DEVICE_MODULE_ID } from '@dg-agent/agent-browser';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { getObservedConversationSequence } from '@dg-agent/storage-browser';
import {
  useShellNav,
  useInShell,
  useOpenShellSettings,
  useSafetySession,
  useTheme,
} from '@0xnullai/ui';
import { useDgLabRegistry, useIsNative, useNativeBridge } from '@0xnullai/native';
import { savedPromptKind, withImportedMarketScene } from '@0xnullai/scenes';
import { useScenes } from '@0xnullai/scenes/react';
import { isSafetyNoticeAccepted, DeviceLifecycleGuard } from '@dg-kit/safety';
import type { UpdateCheckerStatus } from './services/update-checker.js';
import { BUILTIN_PROMPT_PRESETS, DEVICE_KIND_DISPLAY_NAME } from '@dg-agent/runtime';
import {
  RelationshipAccess,
  type RelationshipAccessHandle,
} from './components/RelationshipAccess.js';
import { ChatPanel } from './components/ChatPanel.js';
import {
  canUsePrivateImageInput,
  readPrivateImageForModel,
} from './services/private-image-input.js';
import type { PrivateConversationAttachment } from '@0xnullai/auth';
import { PermissionModal } from '@0xnullai/ui';
import { SafetyNotice } from '@0xnullai/ui';
import { SessionNavigation } from './components/SessionNavigation.js';
import { AgentModuleProjections } from './components/AgentModuleProjections.js';
import { FloatingStatusBar } from './components/FloatingStatusBar.js';
import { WaveformEditorDialog } from './components/WaveformEditorDialog.js';
import { ResetSettingsDialog } from './components/ResetSettingsDialog.js';
import {
  useBrowserAppServices,
  type PendingPermissionRequest,
  type ServicesOverrides,
} from './composition/use-browser-app-services.js';
import { useAuxDeviceState } from './hooks/use-aux-device-state.js';
import { useModelLog } from './hooks/use-model-log.js';
import { throwIfSendAborted, usePendingSends } from './hooks/use-pending-sends.js';
import { useRuntimeSessionState } from './hooks/use-runtime-session-state.js';
import { useVisibleConversationRead } from './hooks/use-visible-conversation-read.js';
import { useSettingsManager } from './hooks/use-settings-manager.js';
import { useToastManager } from './hooks/use-toast-manager.js';
import { useVoiceController } from './hooks/use-voice-controller.js';
import { useWaveformManager } from './hooks/use-waveform-manager.js';
import { createSessionId, isReplyAbortError } from './utils/app-runtime-helpers.js';
import { buildWarnings } from './utils/runtime-warnings.js';
import {
  formatUiErrorMessage,
  getSessionTitle,
  isSessionListEntry,
  isBluetoothChooserCancelledError,
} from './utils/ui-formatters.js';
import {
  clearAgentConversationLink,
  linkedAgentConversationId,
  replaceAgentConversationLink,
} from './utils/conversation-link.js';
import { resolveConversationCards } from './utils/conversation-cards.js';
import {
  parseSessionsFromJson,
  serializeSessionFile,
  sessionFileName,
} from './utils/session-transfer.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { SessionSnapshot } from '@dg-agent/core';

export interface AppProps {
  /**
   * Optional non-device service flags. The Tauri Android shell disables speech, the bridge
   * and the update checker through `NativeBridge.agent.servicesOverrides`.
   */
  servicesOverrides?: ServicesOverrides;
}

export function App({ servicesOverrides }: AppProps = {}) {
  // Native capabilities come from props first (standalone mount), otherwise from
  // NativeBridge (inside the unified shell).
  const native = useNativeBridge();
  const nativeShell = useIsNative();
  // The app's one DG-Lab registry owns every Coyote/Opossum/sensor link (a lazy Web Bluetooth
  // one in a standalone build). Agent opens no BLE connection of its own: a device connected on
  // 设备 is the one the AI chat sees.
  const dglabRegistry = useDgLabRegistry();
  const dglab = useMemo(() => dglabRegistry.forModule(AGENT_DEVICE_MODULE_ID), [dglabRegistry]);
  const nativeOverrides = (native.agent?.servicesOverrides ??
    servicesOverrides) as typeof servicesOverrides;
  const activeSessionIdRef = useRef<string | null>(null);
  const imageConversationEpochRef = useRef(0);
  const bridgeSessionResolverRef = useRef<
    (origin: MessageOrigin) => Promise<string | null> | string | null
  >(() => activeSessionIdRef.current);
  const resolveBridgeSessionId = useCallback(
    (origin: MessageOrigin) => bridgeSessionResolverRef.current(origin),
    [],
  );

  const {
    settingsDraft,
    setSettingsDraft,
    settings,
    setSettings,
    settingsStore,
    resetSettings: resetSettingsManager,
    flushSettingsDraft,
  } = useSettingsManager();

  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null);
  // Per conversation: a reply starting in one conversation never locks another, and a stop
  // pressed before the runtime registered the turn still lands.
  const { pendingSends, pendingIds: pendingSendIds } = usePendingSends();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [runReview, setRunReview] = useState<{
    id: string;
    conversationId: string;
    accountId: string;
    status: AgentRunStatus;
    calls: AgentRunCall[];
  } | null>(null);
  const [dismissedRunReviewId, setDismissedRunReviewId] = useState<string | null>(null);
  const inShell = useInShell();
  const shellNav = useShellNav();
  const openShellSettings = useOpenShellSettings();
  // The scene library moved out of the settings blob into cross-module shared storage —
  // Voice sees the same set, and one broken scene no longer drags the whole settings
  // object back to its defaults (that blob also holds the strength caps).
  const [sceneLib, updateSceneLib] = useScenes();
  const [safetyNoticeAccepted, setSafetyNoticeAccepted] = useState(
    () => inShell || !settings.showSafetyNoticeOnStartup || isSafetyNoticeAccepted(),
  );
  const [transcriptTail, setTranscriptTail] = useState<{
    id: string;
    sequence: number;
    visible: boolean;
  } | null>(null);
  const onTranscriptTailVisibilityChange = useCallback(
    (id: string, sequence: number, visible: boolean) => {
      setTranscriptTail((current) =>
        current?.id === id && current.sequence === sequence && current.visible === visible
          ? current
          : { id, sequence, visible },
      );
    },
    [],
  );
  const [text, setText] = useState('');
  const relationshipAccessRef = useRef<RelationshipAccessHandle>(null);
  const [resetSettingsDialogOpen, setResetSettingsDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const {
    waveformLibrary,
    updateChecker,
    speechRecognition,
    speechSynthesizer,
    speechCapabilities,
    client,
    modes,
    bridgeManager,
    serviceInitWarnings,
    resetPermissionGrants,
    device,
    opossum,
    pawPrints,
    civetEdging,
  } = useBrowserAppServices({
    inShell,
    resolveBridgeSessionId,
    settings,
    scenes: { selectedId: sceneLib.selectedId, saved: sceneLib.scenes },
    setPendingPermission,
    servicesOverrides: nativeOverrides,
    dglab,
    nativeBluetooth: nativeShell,
  });

  const [updateStatus, setUpdateStatus] = useState<UpdateCheckerStatus>(() =>
    updateChecker.getStatus(),
  );
  const voice = useVoiceController({
    speechRecognition,
    speechSynthesizer,
    speechSynthesisEnabled: settings.speechSynthesisEnabled,
    setText,
    setErrorMessage,
    setStatusMessage,
  });

  const modelLog = useModelLog(settings.modelLogEnabled);

  const runtimeSession = useRuntimeSessionState({
    client,
    enabled: safetyNoticeAccepted,
    onError: setErrorMessage,
    onAccountChange: () => {
      resetPermissionGrants();
      setPendingPermission((pending) => {
        pending?.resolve({ type: 'deny', reason: '账户已切换，请重新授权' });
        return null;
      });
    },
    onRuntimeEvent: useCallback(
      (event) => {
        voice.handleRuntimeEvent(event);
        modelLog.ingest(event);
      },
      [voice, modelLog],
    ),
  });

  const waveformManager = useWaveformManager({
    enabled: safetyNoticeAccepted,
    waveformLibrary,
    setErrorMessage,
    setStatusMessage,
  });

  const {
    activeSessionId,
    setActiveSessionId,
    events,
    clearEvents,
    session,
    savedSessions,
    setSavedSessions,
    liveDeviceState,
    replyBusy,
    streamingAssistantText,
    failedReplyText,
    clearStreamingAssistantText,
    liveTraceItems,
    refreshCurrentSession,
    loadOlderSessionMessages,
  } = runtimeSession;

  const agentRouteActive = !shellNav || shellNav.activeId === 'agent';
  // 生成图片 appears only while the server offers it; the owner can keep it closed.
  const [imageGenerationOpen, setImageGenerationOpen] = useState(false);
  useEffect(() => {
    let active = true;
    const check = () => {
      if (!currentAuthUserId()) {
        setImageGenerationOpen(false);
        return;
      }
      void listMediaCapabilities()
        .then(({ items }) => {
          if (active) setImageGenerationOpen(items.some((x) => x.kind === 'image' && x.enabled));
        })
        .catch(() => {
          if (active) setImageGenerationOpen(false);
        });
    };
    check();
    const unsubscribe = subscribeAuthChanges(check);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!agentRouteActive) return;
    let active = true;
    let request = 0;
    let account = currentAuthUserId();
    const openLink = () => {
      const currentRequest = ++request;
      const linkedId = linkedAgentConversationId(window.location.pathname, window.location.search);
      if (!new URLSearchParams(window.location.search).has('conversation')) {
        const selection = readPrivateConversationSelection();
        if (selection)
          queueMicrotask(() => {
            if (active && request === currentRequest) setActiveSessionId(selection.conversationId);
          });
        return;
      }
      if (!linkedId) {
        queueMicrotask(() => {
          if (active && request === currentRequest)
            setErrorMessage('聊天链接无效，请从消息列表重新打开。');
        });
        return;
      }
      const requestedAccount = currentAuthUserId();
      void client
        .listSessions()
        .then((sessions) => {
          if (
            !active ||
            request !== currentRequest ||
            requestedAccount !== currentAuthUserId() ||
            linkedAgentConversationId(window.location.pathname, window.location.search) !== linkedId
          )
            return;
          if (sessions.some((item) => item.id === linkedId)) setActiveSessionId(linkedId);
          else setErrorMessage('找不到这段聊天，或当前账户无权查看。');
        })
        .catch((error) => {
          if (active && request === currentRequest) setErrorMessage(formatUiErrorMessage(error));
        });
    };
    const onAuthChange = () => {
      const nextAccount = currentAuthUserId();
      if (account === nextAccount) return;
      account = nextAccount;
      request++;
      clearAgentConversationLink();
    };
    window.addEventListener('popstate', openLink);
    const unsubscribe = subscribeAuthChanges(onAuthChange);
    openLink();
    return () => {
      active = false;
      request++;
      window.removeEventListener('popstate', openLink);
      unsubscribe();
    };
  }, [agentRouteActive, client, setActiveSessionId, setErrorMessage]);

  const busy = (activeSessionId !== null && pendingSendIds.has(activeSessionId)) || replyBusy;
  const deviceState = liveDeviceState ?? createEmptyDeviceState();
  const connectedCoyotes = connectedCoyoteStates(device, deviceState);
  const activeCoyoteId = supportsCoyoteSelection(device) ? device.deviceId : null;
  const opossumState = useAuxDeviceState(opossum, createEmptyOpossumState());
  const pawPrintsState = useAuxDeviceState(pawPrints, createEmptySensorState());
  const civetEdgingState = useAuxDeviceState(civetEdging, createEmptySensorState());

  const revokeAgentDeviceWork = async (): Promise<void> => {
    // Switching away from Agent also aborts the in-flight reply, not just the output —
    // a tool-call sequence still running would keep issuing commands in the background
    // while the user believes they already left this module. The registry has already
    // stopped every output on the switch, so this drops Agent's own work only: a device
    // stop here bypasses the lease fence and would zero what the new holder starts.
    pendingSends.abort();
    if (!activeSessionId) return;
    await client.abortCurrentReply(activeSessionId).catch(() => undefined);
    await client.releaseDeviceControl(activeSessionId).catch(() => undefined);
  };
  const onRegistryRevoked = useEffectEvent(() => void revokeAgentDeviceWork());

  // Register with the global safety bus — this is the only data source the shell's
  // global stop button has. Before this, nothing in the repo registered, so the button
  // always rendered as null, i.e. it may as well not have existed.
  useSafetySession({
    id: 'agent',
    label: 'Agent',
    // "Holds a connected device" rather than "is currently outputting": see the
    // comment on useSafetySession.
    isActive: () =>
      deviceState.connected ||
      opossumState.connected ||
      pawPrintsState.connected ||
      civetEdgingState.connected,
    connect: () => connect(),
    stop: async () => {
      pendingSends.abort();
      if (activeSessionId) await client.emergencyStop(activeSessionId);
    },
    onRevoke: () => revokeAgentDeviceWork(),
    // The registry's own `dglab-devices` session lists (and, on 设备, disconnects) every
    // device; listing them here too would show each one twice in the shell bar.
  });
  // The registry stops every output on a lease change, then tells the losing module. Agent
  // still has to drop its own in-flight reply, timers and triggers, as the bus revoke does.
  useEffect(() => dglab.onRevoked(() => onRegistryRevoked()), [dglab]);

  const [sensorTriggersEnabled, setSensorTriggersEnabledState] = useState(false);
  const [deviceLinkRule, setDeviceLinkRuleState] = useState<DeviceLinkRule>(() => ({
    ...DEFAULT_DEVICE_LINK_RULE,
  }));
  const setDeviceLinkRule = useCallback(
    (rule: DeviceLinkRule) => {
      setDeviceLinkRuleState(rule);
      void client
        .setDeviceLinkRule(rule)
        .catch((error) => setErrorMessage(formatUiErrorMessage(error)));
    },
    [client],
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        activeSessionId ? client.isSensorTriggersEnabledForSession(activeSessionId) : false,
      )
      .then((enabled) => {
        if (!cancelled) setSensorTriggersEnabledState(enabled);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, client]);
  const toggleSensorTriggers = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!activeSessionId) return;
      try {
        await client.setSensorTriggersEnabled(activeSessionId, enabled);
        setSensorTriggersEnabledState(enabled);
      } catch (error) {
        setErrorMessage(formatUiErrorMessage(error));
      }
    },
    [activeSessionId, client],
  );
  const warnings = [
    ...buildWarnings(settings, modes, speechCapabilities, {
      suppressBridge: nativeOverrides?.disableBridge,
      suppressSpeech: nativeOverrides?.disableSpeech,
    }),
    ...serviceInitWarnings,
  ];
  // Device action notes of the open conversation, oldest first; the trace store is transient,
  // so there is no saved history to merge in.
  const traceFeed = liveTraceItems;

  const { visibleErrorItems, visibleWarnings, visibleEventToasts } = useToastManager({
    errorMessage,
    warnings,
    events,
  });

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    imageConversationEpochRef.current += 1;
  }, [activeSessionId]);

  useEffect(() => {
    bridgeSessionResolverRef.current = async (_origin) => {
      const currentSessionId = activeSessionIdRef.current;
      if (currentSessionId) {
        return currentSessionId;
      }

      const nextSessionId = createSessionId();
      activeSessionIdRef.current = nextSessionId;
      setActiveSessionId(nextSessionId);
      await refreshCurrentSession(nextSessionId);
      return nextSessionId;
    };
  }, [refreshCurrentSession, setActiveSessionId]);

  const {
    voiceMode,
    voiceState,
    voiceTranscript,
    toggleVoiceMode,
    stopSpeechPlayback,
    stopAllVoiceActivity,
  } = voice;

  const {
    waveforms,
    customWaveforms,
    editingWaveform,
    setEditingWaveform,
    importWaveformFiles,
    importWaveformFromMarket,
    removeWaveform,
    openWaveformEditor,
    saveWaveformEdits,
  } = waveformManager;

  // The theme is no longer applied by this module — it is a cross-module global setting
  // owned solely by @0xnullai/ui's store. Here we only subscribe so this module follows
  // along; writes go straight to the store from the settings panel. If we kept applying
  // it locally, switching back to this module would override the shell's choice with our
  // own stale value.
  useTheme();

  useEffect(() => {
    const unsubscribe = updateChecker.subscribe(setUpdateStatus);
    updateChecker.start();
    return () => {
      unsubscribe();
      updateChecker.stop();
    };
  }, [updateChecker]);

  useEffect(() => {
    if (!safetyNoticeAccepted || !settings.bridge.enabled) return;

    let cancelled = false;
    void (async () => {
      try {
        await bridgeManager.start();
        if (cancelled) return;
        const status = bridgeManager.getStatus();
        if (status.adapters.length === 0) {
          setStatusMessage('桥接已启用，但当前没有可用的桥接通道');
          return;
        }
        setStatusMessage('桥接已启动');
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(formatUiErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
      void bridgeManager.stop();
    };
  }, [bridgeManager, safetyNoticeAccepted, settings.bridge.enabled]);

  const denyPendingPermissionRequest = useCallback(
    (reason = '当前回复已停止'): void => {
      if (!pendingPermission) return;
      pendingPermission.resolve({ type: 'deny', reason });
      setPendingPermission(null);
    },
    [pendingPermission],
  );

  useEffect(() => {
    if (!safetyNoticeAccepted) return;
    const guard = new DeviceLifecycleGuard({
      onStop: async (reason) => {
        denyPendingPermissionRequest('当前回复已在页面离开前台时终止');
        stopAllVoiceActivity({ disableMode: true });
        pendingSends.abort();

        if (activeSessionId) {
          await client.abortCurrentReply(activeSessionId);
          await client.emergencyStop(activeSessionId);
        }

        if (reason === 'background-hidden') {
          setStatusMessage('应用切到后台后，已自动停止当前输出');
        }
      },
    });
    return guard.start();
  }, [
    activeSessionId,
    client,
    denyPendingPermissionRequest,
    pendingSends,
    safetyNoticeAccepted,
    stopAllVoiceActivity,
  ]);

  /**
   * Single unified connect entry point: one chooser scoped to all four
   * DG-Lab device kinds, auto-detected and routed to the right client.
   * Click again to add another device — each call opens its own chooser
   * (Web Bluetooth's own security model requires an explicit click per
   * prompt, never auto-repeated).
   */
  const connect = useCallback(async (): Promise<boolean> => {
    if (!activeSessionId) return false;

    try {
      setErrorMessage(null);
      // The one shared picker; a device another module already attached is reused, not
      // reopened. The UI follows a newly picked Coyote.
      const picked = await dglab.connect();
      if (picked.kind === 'coyote' && supportsCoyoteSelection(device)) {
        device.selectDeviceById(picked.id);
      }
      const kind: DeviceKind = picked.kind;
      setStatusMessage(`${DEVICE_KIND_DISPLAY_NAME[kind]}已连接`);
      await refreshCurrentSession(activeSessionId);
      return true;
    } catch (error) {
      if (isBluetoothChooserCancelledError(error)) {
        setErrorMessage(null);
        setStatusMessage(
          liveDeviceState.connected
            ? '已取消重连，当前设备连接保持不变'
            : '已取消设备选择，当前仍未连接设备',
        );
        return false;
      }
      setErrorMessage(formatUiErrorMessage(error));
      return false;
    }
  }, [activeSessionId, dglab, device, liveDeviceState.connected, refreshCurrentSession]);

  const { characterId: conversationCharacterId, sceneId: conversationSceneId } =
    resolveConversationCards(session, activeSessionId, sceneLib);
  const hasExplicitConversationScene =
    session?.id === activeSessionId && typeof session.metadata?.sceneId === 'string';

  const refreshRunReview = useCallback(async (conversationId: string) => {
    const accountId = currentAuthUserId();
    if (!accountId) {
      setRunReview(null);
      return;
    }
    try {
      const { items } = await listAgentRuns(conversationId);
      const unresolved = items.find(
        (item) => item.status === 'active' || item.status === 'needs_review',
      );
      if (!unresolved) {
        if (accountId === currentAuthUserId() && activeSessionIdRef.current === conversationId)
          setRunReview(null);
        return;
      }
      const { item, calls } = await getAgentRun(conversationId, unresolved.id);
      if (accountId === currentAuthUserId() && activeSessionIdRef.current === conversationId)
        setRunReview(
          item.status === 'active' || item.status === 'needs_review'
            ? { id: item.id, conversationId, accountId, status: item.status, calls }
            : null,
        );
    } catch {
      // Chat remains usable; a failed recovery read must not invent a verified outcome.
      if (accountId === currentAuthUserId() && activeSessionIdRef.current === conversationId)
        setRunReview(null);
    }
  }, []);
  useEffect(() => {
    if (!activeSessionId) {
      queueMicrotask(() => setRunReview(null));
      return;
    }
    const sessionId = activeSessionId;
    queueMicrotask(() => void refreshRunReview(sessionId));
  }, [activeSessionId, client, refreshRunReview]);

  async function changeConversationScene(id: string | null): Promise<void> {
    if (!activeSessionId) return;
    try {
      setErrorMessage(null);
      await client.setSessionScene(activeSessionId, id);
      await refreshCurrentSession(activeSessionId);
      setStatusMessage(id ? '已切换场景' : '已移除场景');
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function switchConversationMode(mode: 'voice' | 'video') {
    const accountId = currentAuthUserId();
    if (!accountId || !activeSessionId) {
      setErrorMessage('请先登录并打开私人对话。');
      return;
    }
    if (!conversationCharacterId) {
      setErrorMessage('这段聊天没有角色身份。请先打开角色聊天，再进入语音或摄像头观察。');
      return;
    }
    try {
      await refreshCurrentSession(activeSessionId);
      selectPrivateConversation({
        accountId,
        conversationId: activeSessionId,
        characterId: conversationCharacterId,
        ...(typeof session?.metadata?.relationshipId === 'string'
          ? { relationshipId: session.metadata.relationshipId }
          : {}),
      });
      if (conversationCharacterId)
        updateSceneLib((current) => ({ ...current, selectedId: conversationCharacterId }));
      shellNav?.navigate(mode);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  const sendTextMessage = useCallback(
    async (message: string, image?: LlmImageInput): Promise<'sent' | 'aborted' | 'failed'> => {
      if (!message.trim() || !activeSessionId) return 'failed';

      const sessionId = activeSessionId;
      // Live from the press: a stop during the network steps below must keep the turn from
      // ever starting, not just abort a turn the runtime has already registered.
      const controller = pendingSends.begin(sessionId);
      const { signal } = controller;
      let allocatedRunId: string | null = null;
      let handedToRuntime = false;
      try {
        setErrorMessage(null);
        stopSpeechPlayback();

        if (conversationSceneId && !hasExplicitConversationScene) {
          await client.setSessionScene(sessionId, conversationSceneId);
        }
        throwIfSendAborted(signal);

        // Persist the empty server conversation before allocating the authoritative run.
        await client.getSessionDisplaySnapshot(sessionId);
        throwIfSendAborted(signal);
        const requestId = `web-${crypto.randomUUID()}`;
        const { item: run, claimed } = await startAgentRun(sessionId, requestId);
        if (!claimed || run.status !== 'active') throw new Error('服务器任务已存在，请刷新后重试');
        allocatedRunId = run.id;
        throwIfSendAborted(signal);

        handedToRuntime = true;
        await client.sendUserMessage({
          sessionId,
          runId: run.id,
          text: message,
          image,
          characterId: conversationCharacterId,
          abortSignal: signal,
          context: {
            sessionId,
            sourceType: 'web',
            traceId: requestId,
          },
        });
        allocatedRunId = null;

        // The turn's end event already re-reads the conversation.
        setStatusMessage('消息已发送');
        void refreshRunReview(sessionId);
        return 'sent';
      } catch (error) {
        // A run stopped before the runtime saw it executed nothing, so it is cancelled
        // outright; after hand-over its outcome is unknown and needs review.
        if (allocatedRunId)
          void finishAgentRun(
            sessionId,
            allocatedRunId,
            handedToRuntime ? 'needs_review' : 'cancelled',
          )
            .catch(() => undefined)
            .finally(() => void refreshRunReview(sessionId));
        if (isReplyAbortError(error)) {
          setStatusMessage('已停止当前回复');
          return 'aborted';
        }
        setErrorMessage(formatUiErrorMessage(error));
        return 'failed';
      } finally {
        pendingSends.end(sessionId, controller);
      }
    },
    [
      activeSessionId,
      client,
      conversationCharacterId,
      conversationSceneId,
      hasExplicitConversationScene,
      pendingSends,
      refreshRunReview,
      stopSpeechPlayback,
    ],
  );

  async function send(): Promise<void> {
    const draft = text;
    if (!draft.trim()) return;

    setText('');
    const result = await sendTextMessage(draft);
    if (result === 'failed') {
      setText(draft);
    }
  }

  async function askAboutImage(attachment: PrivateConversationAttachment): Promise<void> {
    const accountId = currentAuthUserId();
    const conversationId = activeSessionId;
    if (
      !accountId ||
      !conversationId ||
      !canUsePrivateImageInput(client.capabilities.imageInput, settings.provider.providerId)
    ) {
      setErrorMessage('自备模型需要在「AI → 高级」打开「支持图片输入」才能看图');
      return;
    }
    const conversationEpoch = imageConversationEpochRef.current;
    let accountChanged = false;
    const unsubscribeAuth = subscribeAuthChanges(() => {
      accountChanged = true;
    });
    // Reading the image is part of the send: the conversation shows busy and stop cancels it.
    const reading = pendingSends.begin(conversationId);
    try {
      setErrorMessage(null);
      const image = await readPrivateImageForModel(accountId, conversationId, attachment);
      if (
        reading.signal.aborted ||
        accountChanged ||
        currentAuthUserId() !== accountId ||
        activeSessionIdRef.current !== conversationId ||
        imageConversationEpochRef.current !== conversationEpoch
      )
        return;
      await sendTextMessage('请根据我选择的图片回答；如果看不清，请明确说明。', image);
    } catch (error) {
      if (
        !accountChanged &&
        currentAuthUserId() === accountId &&
        activeSessionIdRef.current === conversationId &&
        imageConversationEpochRef.current === conversationEpoch
      )
        setErrorMessage(formatUiErrorMessage(error));
    } finally {
      unsubscribeAuth();
      pendingSends.end(conversationId, reading);
    }
  }

  async function stop(): Promise<void> {
    if (!activeSessionId) return;

    try {
      setErrorMessage(null);
      denyPendingPermissionRequest('当前回复已通过紧急停止终止');
      stopAllVoiceActivity({ disableMode: true });
      pendingSends.abort();
      await client.abortCurrentReply(activeSessionId);
      await client.emergencyStop(activeSessionId);
      setStatusMessage('已发送紧急停止');
      await refreshCurrentSession(activeSessionId);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function abortCurrentReply(): Promise<void> {
    if (!activeSessionId) return;

    try {
      setErrorMessage(null);
      denyPendingPermissionRequest();
      stopSpeechPlayback();
      pendingSends.abort(activeSessionId);
      await client.abortCurrentReply(activeSessionId);
      clearStreamingAssistantText();
      setStatusMessage('已停止当前回复');
    } catch (error) {
      if (isReplyAbortError(error)) {
        setStatusMessage('已停止当前回复');
        return;
      }
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function createNewSession(): Promise<void> {
    flushSettingsDraft();
    setEditingWaveform(null);
    // Per-command/timed grants are conversation-scoped, but the explicit
    // "完全放行" mode is a browser-session setting and must survive creating
    // or switching conversations.
    resetPermissionGrants();

    if (activeSessionId) {
      try {
        denyPendingPermissionRequest('已因新建会话终止当前回复');
        stopAllVoiceActivity({ disableMode: true });
        pendingSends.abort(activeSessionId);
        await client.abortCurrentReply(activeSessionId);
      } catch (error) {
        if (!isReplyAbortError(error)) {
          setErrorMessage(formatUiErrorMessage(error));
        }
      }

      try {
        await client.emergencyStop(activeSessionId);
      } catch (error) {
        setErrorMessage(formatUiErrorMessage(error));
      }
    }

    const nextSessionId = createSessionId();
    replaceAgentConversationLink(nextSessionId);
    setActiveSessionId(nextSessionId);
    setText('');
    clearStreamingAssistantText();
    clearEvents();
    setErrorMessage(null);
    setStatusMessage('已创建新会话');
    setSidebarOpen(false);
  }

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      pendingSends.abort(sessionId);
      await client.deleteSession(sessionId);
      const remaining = await client.listSessions();
      setSavedSessions(remaining);

      if (sessionId === activeSessionId) {
        const nextSessionId = remaining[0]?.id ?? createSessionId();
        replaceAgentConversationLink(nextSessionId);
        setActiveSessionId(nextSessionId);
        setText('');
        clearStreamingAssistantText();
        stopAllVoiceActivity({ disableMode: false });
        clearEvents();
      }

      setStatusMessage('会话已删除');
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  async function renameSession(sessionId: string, title: string | null): Promise<void> {
    try {
      await client.renameSession(sessionId, title);
      if (sessionId === activeSessionId) await refreshCurrentSession(sessionId);
      else setSavedSessions(await client.listSessions());
      setStatusMessage(title ? '对话已重命名' : '已恢复自动标题');
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // Export the chosen sessions as a zip with one JSON file per session.
  async function exportSessions(sessionIds: string[]): Promise<void> {
    try {
      // Read and verify each complete transcript page by page; the navigation
      // list contains summaries only.
      const chosen: SessionSnapshot[] = [];
      for (const id of new Set(sessionIds)) chosen.push(await client.getSessionExportSnapshot(id));
      if (chosen.length === 0) {
        setStatusMessage('请选择要导出的会话');
        return;
      }
      const exportedAt = Date.now();
      const files: Record<string, Uint8Array> = {};
      for (const session of chosen) {
        let name = sessionFileName(session);
        // Guard against (unlikely) filename collisions inside the zip.
        for (let i = 2; name in files; i += 1) {
          name = sessionFileName(session).replace(/\.json$/, `-${i}.json`);
        }
        files[name] = strToU8(serializeSessionFile(session, exportedAt));
      }
      const zipped = zipSync(files);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      triggerDownload(
        new Blob([zipped], { type: 'application/zip' }),
        `dg-agent-chat-${stamp}.zip`,
      );
      setStatusMessage(`已导出 ${chosen.length} 个会话`);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  // Import from a zip (one JSON per session) or a single JSON file.
  async function importSessions(file: File): Promise<void> {
    try {
      const sessions: SessionSnapshot[] = [];
      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        for (const [name, content] of Object.entries(entries)) {
          if (!/\.json$/i.test(name)) continue;
          sessions.push(...parseSessionsFromJson(strFromU8(content)));
        }
      } else {
        sessions.push(...parseSessionsFromJson(await file.text()));
      }
      if (sessions.length === 0) {
        setStatusMessage('文件中没有会话');
        return;
      }
      await client.importSessions(sessions);
      setSavedSessions(await client.listSessions());
      setStatusMessage(`已导入 ${sessions.length} 个会话`);
    } catch (error) {
      setErrorMessage(formatUiErrorMessage(error));
    }
  }

  function selectSession(sessionId: string): void {
    if (sessionId === activeSessionId) {
      return;
    }
    flushSettingsDraft();
    setEditingWaveform(null);
    // The reply of the conversation being left stops with it: once it is off screen its stop
    // button is gone, so it must not keep running (and reaching devices) in the background.
    if (activeSessionId) {
      denyPendingPermissionRequest('已因切换会话终止当前回复');
      pendingSends.abort(activeSessionId);
      void client.abortCurrentReply(activeSessionId).catch(() => undefined);
    }
    resetPermissionGrants();
    replaceAgentConversationLink(sessionId);
    setActiveSessionId(sessionId);
    setText('');
    clearStreamingAssistantText();
    stopAllVoiceActivity({ disableMode: false });
    setErrorMessage(null);
    setStatusMessage('已切换到所选会话');
    setSidebarOpen(false);
  }

  const consumeInboxSelection = useEffectEvent(() => {
    const selection = consumeAgentInboxSelection();
    if (selection?.kind === 'conversation') selectSession(selection.id);
    if (selection?.kind === 'new') void createNewSession();
  });
  const inboxRouteActive = agentRouteActive;
  const observedSequence = getObservedConversationSequence(session, currentAuthUserId());
  useVisibleConversationRead({
    session,
    activeSessionId,
    visible:
      inboxRouteActive &&
      safetyNoticeAccepted &&
      !sidebarOpen &&
      transcriptTail?.visible === true &&
      transcriptTail.id === session?.id &&
      transcriptTail.sequence === observedSequence,
  });
  useEffect(() => {
    if (!inboxRouteActive) return;
    let active = true;
    queueMicrotask(() => {
      if (active) consumeInboxSelection();
    });
    const unsubscribe = subscribeAgentInboxSelection(() => consumeInboxSelection());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [inboxRouteActive]);

  function resetSettings(): void {
    resetSettingsManager(() => {
      setStatusMessage('设置已恢复默认值');
      clearEvents();
    });
  }

  function resolvePermission(decision: PermissionDecision): void {
    if (!pendingPermission) return;
    pendingPermission.resolve(decision);
    setPendingPermission(null);
  }

  function handleSafetyNoticeAccept(options: { dontShowAgain: boolean }): void {
    const nextSettings = settingsStore.save({
      ...settings,
      showSafetyNoticeOnStartup: !options.dontShowAgain,
    });
    setSettings(nextSettings);
    setSettingsDraft(nextSettings);
    setSafetyNoticeAccepted(true);
  }

  const sessionNavigation = {
    sessions: savedSessions,
    activeSessionId,
    onSelect: selectSession,
    onSearch: (query: string) => client.searchSessions(query),
    onRename: (sessionId: string, title: string | null) => void renameSession(sessionId, title),
    onDelete: (sessionId: string) => void deleteSession(sessionId),
    onCreate: () => void createNewSession(),
  };

  return (
    <>
      <main
        className={`relative flex h-full min-h-0 flex-col overflow-hidden ${inShell ? '' : 'pt-[env(safe-area-inset-top)]'}`}
        aria-hidden={!safetyNoticeAccepted}
      >
        {pendingPermission && (
          <PermissionModal
            summary={pendingPermission.input.summary}
            args={pendingPermission.input.args}
            onDeny={() => resolvePermission({ type: 'deny' })}
            onAllowOnce={() => resolvePermission({ type: 'approve-once' })}
            onAllowTimed={() =>
              resolvePermission({ type: 'approve-scoped', expiresAt: Date.now() + 5 * 60_000 })
            }
            onAllowSession={() => resolvePermission({ type: 'approve-scoped' })}
          />
        )}

        <WaveformEditorDialog
          editingWaveform={editingWaveform}
          onEditingWaveformChange={setEditingWaveform}
          onSave={saveWaveformEdits}
        />

        <ResetSettingsDialog
          open={resetSettingsDialogOpen}
          onOpenChange={setResetSettingsDialogOpen}
          onConfirm={resetSettings}
        />

        <AgentModuleProjections
          sensors={{
            settingsDraft,
            setSettingsDraft,
            sensorTriggersEnabled,
            onToggleSensorTriggers: (enabled) => void toggleSensorTriggers(enabled),
            deviceLinkRule,
            onSetDeviceLinkRule: setDeviceLinkRule,
          }}
          waveforms={{
            waveforms,
            customWaveforms,
            onImport: (files) => void importWaveformFiles(files),
            onImportFromMarket: (waveform) => void importWaveformFromMarket(waveform),
            onRemove: (id) => void removeWaveform(id),
            onEdit: openWaveformEditor,
          }}
          data={{
            sessions: savedSessions.filter(isSessionListEntry).map((session) => ({
              id: session.id,
              title: getSessionTitle(session),
              updatedAt: session.updatedAt,
            })),
            onExport: (ids) => void exportSessions(ids),
            onImport: (file) => void importSessions(file),
          }}
        />

        <SessionNavigation
          variant="mobile"
          {...sessionNavigation}
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          onOpenSettings={() => openShellSettings()}
        />

        {/* ===== Main layout ===== */}
        {/* In the shell only one column is left: the sidebar is owned by the shell and the
            session list registers into the 「对话」 section via useRegisterSidebarSection.
            If the module drew a second sidebar of its own, there would be two side by side. */}
        <section
          className={
            inShell
              ? 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden'
              : 'grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-[var(--dur-slow)] ease-out lg:grid-cols-[var(--sidebar-w-agent)_minmax(0,1fr)]'
          }
          style={
            {
              '--sidebar-w-agent': sidebarCollapsed ? '65px' : '272px',
            } as React.CSSProperties
          }
        >
          {!inShell && (
            <SessionNavigation
              variant="desktop"
              {...sessionNavigation}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              onOpenSettings={() => openShellSettings()}
            />
          )}

          {/* Chat section */}
          <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
            <RelationshipAccess
              ref={relationshipAccessRef}
              conversationId={activeSessionId ?? undefined}
              characterId={conversationCharacterId}
              marketPortraitId={
                sceneLib.scenes.find(
                  (scene) => scene.id === (conversationCharacterId || conversationSceneId),
                )?.marketPortraitId
              }
              onBack={shellNav?.conversationBack}
              characterIcon={
                sceneLib.scenes.find(
                  (scene) => scene.id === (conversationCharacterId || conversationSceneId),
                )?.icon
              }
              scenes={sceneLib.scenes.filter((scene) => savedPromptKind(scene) === 'scene')}
              sceneId={conversationSceneId || null}
              onSceneChange={(id) => void changeConversationScene(id)}
              onImportScene={(item) =>
                updateSceneLib((prev) => withImportedMarketScene(prev, item))
              }
              characterName={
                sceneLib.scenes.find((scene) => scene.id === conversationCharacterId)?.name ??
                BUILTIN_PROMPT_PRESETS.find((preset) => preset.id === conversationCharacterId)
                  ?.name ??
                // A scene-only chat is named after the scene it hosts.
                (!conversationCharacterId && conversationSceneId
                  ? sceneLib.scenes.find((scene) => scene.id === conversationSceneId)?.name
                  : undefined) ??
                'AI'
              }
            />
            <FloatingStatusBar
              voiceMode={voiceMode}
              voiceState={voiceState}
              voiceTranscript={voiceTranscript}
              errorItems={visibleErrorItems}
              warnings={visibleWarnings}
              eventToasts={visibleEventToasts}
              updateStatus={updateStatus}
              onDismissUpdate={() => updateChecker.dismiss()}
              onReload={() => window.location.reload()}
            />
            {runReview &&
            runReview.conversationId === activeSessionId &&
            runReview.accountId === currentAuthUserId() &&
            runReview.id !== dismissedRunReviewId ? (
              <div
                role="status"
                className="border-b border-[var(--surface-border)] bg-[var(--bg-soft)] px-4 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    {runReview.status === 'active'
                      ? '此会话仍有进行中的任务。若原窗口已关闭，任务结果可能未确认；请检查实际状态，待服务器结束旧任务后再发送。'
                      : '有操作结果待核对。请检查实际状态，再决定是否重试。'}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-[var(--accent)]"
                    onClick={() => void refreshRunReview(runReview.conversationId)}
                  >
                    刷新
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-[var(--accent)]"
                    onClick={() => setDismissedRunReviewId(runReview.id)}
                  >
                    关闭
                  </button>
                </div>
                {runReview.calls.length > 0 ? (
                  <details className="mt-1 text-xs text-[var(--text-soft)]">
                    <summary className="cursor-pointer">查看调用记录</summary>
                    <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                      {runReview.calls.map((call) => (
                        <li key={call.callId}>
                          {call.name}：
                          {call.status === 'succeeded'
                            ? '客户端报告成功，未独立核验'
                            : call.status === 'failed'
                              ? '失败'
                              : call.status === 'denied'
                                ? '已拒绝'
                                : '未确认'}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
            <ChatPanel
              accountId={currentAuthUserId()}
              activeSessionId={activeSessionId}
              text={text}
              statusMessage={statusMessage}
              onTextChange={setText}
              onAbortReply={() => void abortCurrentReply()}
              onToggleVoiceMode={() => void toggleVoiceMode()}
              onSend={() => void send()}
              onAskImage={(attachment) => void askAboutImage(attachment)}
              onAttachmentCommitted={(id) => void refreshCurrentSession(id)}
              onReplyToVoice={(attachment) => {
                const id = activeSessionId;
                const accountId = currentAuthUserId();
                if (!id || !accountId || !attachment.caption) return;
                let accountChanged = false;
                const unsubscribe = subscribeAuthChanges(() => {
                  accountChanged = true;
                });
                void (async () => {
                  try {
                    await refreshCurrentSession(id);
                    if (
                      accountChanged ||
                      currentAuthUserId() !== accountId ||
                      activeSessionIdRef.current !== id
                    )
                      return;
                    await sendTextMessage('请回应我刚发的语音文字；录音本身没有经过自动识别。');
                  } catch (error) {
                    if (
                      !accountChanged &&
                      currentAuthUserId() === accountId &&
                      activeSessionIdRef.current === id
                    )
                      setErrorMessage(formatUiErrorMessage(error));
                  } finally {
                    unsubscribe();
                  }
                })();
              }}
              onVoiceCall={shellNav ? () => void switchConversationMode('voice') : undefined}
              onCamera={shellNav ? () => void switchConversationMode('video') : undefined}
              onGenerateMedia={
                imageGenerationOpen ? () => relationshipAccessRef.current?.openMedia() : undefined
              }
              imageInputSupported={canUsePrivateImageInput(
                client.capabilities.imageInput,
                settings.provider.providerId,
              )}
              busy={busy}
              speechRecognitionEnabled={settings.speechRecognitionEnabled}
              voiceMode={voiceMode}
              voiceState={voiceState}
              speechRecognitionSupported={speechCapabilities.recognitionSupported}
              session={session}
              onLoadEarlier={loadOlderSessionMessages}
              observedSequence={observedSequence}
              onTranscriptTailVisibilityChange={onTranscriptTailVisibilityChange}
              traceFeed={traceFeed}
              streamingAssistantText={streamingAssistantText}
              failedReplyText={failedReplyText}
              deviceState={deviceState}
              maxStrengthA={settings.maxStrengthA}
              maxStrengthB={settings.maxStrengthB}
              opossumState={opossumState}
              maxOpossumIntensityA={settings.maxOpossumIntensityA}
              maxOpossumIntensityB={settings.maxOpossumIntensityB}
              pawPrintsState={pawPrintsState}
              civetEdgingState={civetEdgingState}
              onConnect={() => void connect()}
              onEmergencyStop={() => void stop()}
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenSettings={() => openShellSettings('scenes')}
              promptPresetId={conversationCharacterId}
              hostPresetId={conversationCharacterId || conversationSceneId}
              savedPresets={sceneLib.scenes}
              coyoteTargets={connectedCoyotes.map(({ id, state }, index) => ({
                id,
                label:
                  connectedCoyotes.length > 1
                    ? `${state.deviceName ?? '郊狼'} ${index + 1}`
                    : (state.deviceName ?? '郊狼'),
              }))}
              activeCoyoteId={activeCoyoteId}
              onCoyoteTargetChange={(id) => {
                if (!supportsCoyoteSelection(device)) return;
                try {
                  device.selectDeviceById(id);
                  setStatusMessage('已切换 AI 控制设备');
                } catch (error) {
                  setErrorMessage(formatUiErrorMessage(error));
                }
              }}
            />
          </section>
        </section>
      </main>

      {/* Inside the shell, the shell is the single gatekeeper — the same notice should not
          be confirmed a second time on entering Agent. */}
      {/* The session list is projected into the shell sidebar's 「对话」 section. The module
          no longer draws a sidebar of its own. */}
      <SessionNavigation variant="shell" {...sessionNavigation} />

      {!inShell && !safetyNoticeAccepted && (
        <SafetyNotice moduleId="agent" onAccept={handleSafetyNoticeAccept} />
      )}
    </>
  );
}

interface MultiCoyoteSnapshotClient {
  getConnectedCoyotes(): Array<{ id: string; state: DeviceState }>;
}

interface MultiCoyoteSelectionClient extends MultiCoyoteSnapshotClient {
  readonly deviceId: string | null;
  selectDeviceById(deviceId: string): void;
}

function supportsCoyoteSnapshots(
  client: DeviceClient,
): client is DeviceClient & MultiCoyoteSnapshotClient {
  return typeof (client as Partial<MultiCoyoteSnapshotClient>).getConnectedCoyotes === 'function';
}

function supportsCoyoteSelection(
  client: DeviceClient,
): client is DeviceClient & MultiCoyoteSelectionClient {
  return (
    supportsCoyoteSnapshots(client) &&
    typeof (client as Partial<MultiCoyoteSelectionClient>).selectDeviceById === 'function'
  );
}

function connectedCoyoteStates(
  client: DeviceClient,
  fallback: DeviceState,
): Array<{ id: string; state: DeviceState }> {
  if (supportsCoyoteSnapshots(client)) return client.getConnectedCoyotes();
  return fallback.connected ? [{ id: 'coyote', state: fallback }] : [];
}
