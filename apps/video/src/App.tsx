import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePause, CirclePlay, ShieldAlert } from 'lucide-react';
import { Button, useOpenShellSettings, useSafetySession } from '@0xnullai/ui';
import {
  isVideoLlmConfigured,
  loadVideoLlmConfig,
  normalizeProviderSettings,
  subscribeVideoLlmConfig,
  type VideoLlmConfig,
  type ProviderId,
} from '@0xnullai/llm-providers';
import { loadDeviceSafety, subscribeDeviceSafety } from '@0xnullai/settings';
import { useEmbeddedDeviceRuntimeEnabled, useNativeBridge } from '@0xnullai/native';
import { useScenes } from '@0xnullai/scenes/react';
import { grantDeviceLease, hasDeviceLease } from '@dg-kit/safety';
import {
  createUnifiedOutputTargets,
  genericDeviceIntensityCap,
  genericDeviceSafetyPolicy,
  outputTargetSafetyControl,
  type DeviceSnapshot,
  type UnifiedOutputTarget,
} from '@0xnullai/device-runtime';
import {
  createBrowserLlmClient,
  createBrowserVideoControl,
  type BrowserVideoControlService,
  type BrowserVideoDeviceSnapshot,
  type VideoOutputKind,
} from '@dg-agent/agent-browser';
import type { LlmClient } from '@dg-agent/core';
import { BUILTIN_PROMPT_PRESETS, getAnyPromptPresetById } from '@dg-agent/runtime';
import { CameraWorkbench } from './components/CameraWorkbench.js';
import { VideoSetupPanel } from './components/VideoSetupPanel.js';
import { useCameraPreview, type CameraFacingMode } from './hooks/use-camera-preview.js';
import { DEFAULT_CAMERA_FRAME_SETTINGS } from './services/camera-frame.js';
import { VisualSession, type VisualSessionSnapshot } from './services/visual-session.js';
import { DeviceRuntimeVideoControlService } from './services/device-runtime-video-control.js';
import {
  VideoAiDeviceRouter,
  type VideoAiAllowedTarget,
  type VideoAiRoutingGrantSnapshot,
} from './services/video-ai-device-router.js';

const INITIAL_VISUAL_STATE: VisualSessionSnapshot = {
  status: 'idle',
  steps: 0,
  requestInFlight: false,
  latestFrame: null,
  latestExplanation: '',
  consecutiveModelFailures: 0,
  emergencyLatched: false,
  stopReason: null,
  error: null,
};

const EMPTY_DEVICE_SNAPSHOT: BrowserVideoDeviceSnapshot = {
  coyote: {
    connected: false,
    battery: 0,
    strengthA: 0,
    strengthB: 0,
    limitA: 0,
    limitB: 0,
    waveActiveA: false,
    waveActiveB: false,
  },
  opossum: { connected: false, battery: 0, intensityA: 0, intensityB: 0 },
  coyotes: [],
  opossumTarget: null,
};

const FIXED_CAMERA_FRAME_SETTINGS = Object.freeze({
  ...DEFAULT_CAMERA_FRAME_SETTINGS,
  cropPreset: '16:9' as const,
  outputMaxEdge: 768,
});

class GenericVideoServiceSlot {
  private value: DeviceRuntimeVideoControlService | null = null;

  get(): DeviceRuntimeVideoControlService | null {
    return this.value;
  }

  set(service: DeviceRuntimeVideoControlService | null): void {
    this.value = service;
  }

  clear(service: DeviceRuntimeVideoControlService): void {
    if (this.value === service) this.value = null;
  }
}

function llmForConfig(config: VideoLlmConfig): LlmClient {
  const provider = normalizeProviderSettings({
    providerId: config.providerId as ProviderId,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    useStrict: config.useStrict,
  });
  return createBrowserLlmClient({ provider, temperature: 0.2 });
}

function toVideoSafety() {
  const safety = loadDeviceSafety();
  return {
    maxStrengthA: safety.maxStrengthA,
    maxStrengthB: safety.maxStrengthB,
    maxColdStartStrength: safety.maxColdStartStrength,
    maxAdjustStep: safety.maxAdjustStep,
    maxBurstDurationMs: safety.maxBurstDurationMs,
    maxBurstStrengthAbsolute: safety.maxBurstStrengthAbsolute,
    maxBurstStrengthRelative: safety.maxBurstStrengthRelative,
    maxIntensityA: safety.maxIntensityA,
    maxIntensityB: safety.maxIntensityB,
    maxColdStartIntensity: safety.maxColdStartIntensity,
    maxOpossumAdjustStep: safety.maxOpossumAdjustStep,
    maxToolIterations: safety.maxToolIterations,
    maxToolCallsPerTurn: safety.maxToolCallsPerTurn,
    maxAdjustStrengthCallsPerTurn: safety.maxAdjustStrengthCallsPerTurn,
    maxBurstCallsPerTurn: safety.maxBurstCallsPerTurn,
    maxVibrateAdjustCallsPerTurn: safety.maxVibrateAdjustCallsPerTurn,
    maxVibrateBurstCallsPerTurn: safety.maxVibrateBurstCallsPerTurn,
    burstRequiresActiveChannel: safety.burstRequiresActiveChannel,
  };
}

function useStopWhenModuleHidden(stop: () => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const slot = root?.closest('[aria-hidden]');
    if (!slot) return;
    const observer = new MutationObserver(() => {
      if (slot.getAttribute('aria-hidden') === 'true') stop();
    });
    observer.observe(slot, { attributes: true, attributeFilter: ['aria-hidden', 'hidden'] });
    return () => observer.disconnect();
  }, [stop]);
  return rootRef;
}

export function App() {
  const [config, setConfig] = useState(loadVideoLlmConfig);
  const [safety, setSafety] = useState(toVideoSafety);
  const [sceneLibrary, updateSceneLibrary] = useScenes();
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [cadenceSeconds, setCadenceSeconds] = useState(10);
  const captureIntervalMs = 1_000;
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [allowEnhanced, setAllowEnhanced] = useState(false);
  const [allowBurst, setAllowBurst] = useState(false);
  const [routingGrant, setRoutingGrant] = useState<VideoAiRoutingGrantSnapshot | null>(null);
  const [devices, setDevices] = useState(EMPTY_DEVICE_SNAPSHOT);
  const [embeddedDeviceState, setEmbeddedDeviceState] = useState<{
    service: DeviceRuntimeVideoControlService;
    snapshot: DeviceSnapshot;
  } | null>(null);
  const [visual, setVisual] = useState(INITIAL_VISUAL_STATE);
  const [observations, setObservations] = useState<Array<{ step: number; text: string }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const outputTargetsRef = useRef<UnifiedOutputTarget[]>([]);
  const startOperationRef = useRef(0);
  const autoStartRef = useRef<number | null>(null);
  const lifecycleEffectRef = useRef(0);
  const invalidatePendingStart = useCallback(() => {
    startOperationRef.current += 1;
    autoStartRef.current = null;
  }, []);
  const openSettings = useOpenShellSettings();
  const native = useNativeBridge();
  const genericDevicesEnabled = useEmbeddedDeviceRuntimeEnabled();
  const createControlService = (native.video?.createControlService ??
    createBrowserVideoControl) as typeof createBrowserVideoControl;

  useEffect(() => subscribeVideoLlmConfig(setConfig), []);
  useEffect(() => subscribeDeviceSafety(() => setSafety(toVideoSafety())), []);

  const llm = useMemo(() => {
    try {
      return llmForConfig(config);
    } catch {
      return null;
    }
  }, [config]);
  const [service] = useState(() =>
    createControlService({
      getLlm: () => llm,
      getSafetyLimits: () => safety,
      getSceneLibrary: () => sceneLibrary,
    }),
  );

  useEffect(() => {
    service.updateInputs({ llm, safetyLimits: safety, sceneLibrary });
  }, [llm, safety, sceneLibrary, service]);
  useEffect(() => service.subscribe(setDevices), [service]);

  const embeddedScene = useMemo(() => {
    const selected = getAnyPromptPresetById(sceneLibrary.selectedId, sceneLibrary.scenes);
    return selected ? { name: selected.name, prompt: selected.prompt } : null;
  }, [sceneLibrary]);
  const sceneOptions = useMemo(
    () => [
      ...BUILTIN_PROMPT_PRESETS.filter(
        (scene) => !sceneLibrary.hiddenBuiltinIds.includes(scene.id),
      ),
      ...sceneLibrary.scenes,
    ],
    [sceneLibrary.hiddenBuiltinIds, sceneLibrary.scenes],
  );
  const selectedSceneId = sceneOptions.some((scene) => scene.id === sceneLibrary.selectedId)
    ? sceneLibrary.selectedId
    : '';
  const genericService = useMemo(
    () =>
      native.deviceRuntime && genericDevicesEnabled
        ? new DeviceRuntimeVideoControlService({
            provider: native.deviceRuntime,
            llm: null,
            scene: null,
            hasLease: () => hasDeviceLease('video'),
            getSafetyIntensityCap: () => genericDeviceIntensityCap(loadDeviceSafety()),
            getMaxOutputLeaseMs: () =>
              genericDeviceSafetyPolicy(loadDeviceSafety()).maxOutputLeaseMs,
          })
        : null,
    [genericDevicesEnabled, native.deviceRuntime],
  );
  const [genericServiceSlot] = useState(() => new GenericVideoServiceSlot());
  const embeddedDevices =
    genericService && embeddedDeviceState?.service === genericService
      ? embeddedDeviceState.snapshot
      : null;
  useEffect(() => {
    genericService?.updateInputs({ llm, scene: embeddedScene });
  }, [embeddedScene, genericService, llm]);
  useEffect(() => {
    genericServiceSlot.set(genericService);
    if (!genericService) return;
    const unsubscribe = genericService.subscribe((snapshot) =>
      setEmbeddedDeviceState({ service: genericService, snapshot }),
    );
    return () => {
      genericServiceSlot.clear(genericService);
      unsubscribe();
      void genericService.dispose();
    };
  }, [genericService, genericServiceSlot]);
  const [aiRouter] = useState(
    () =>
      new VideoAiDeviceRouter({
        getLlm: () => null,
        getTargets: () => [],
        hasLease: () => hasDeviceLease('video'),
        invoke: async (action, masterGrant) => {
          const remaining = Math.max(1_000, masterGrant.expiresAt - Date.now());
          if (action.target.kind === 'embedded') {
            const currentGenericService = genericServiceSlot.get();
            if (!currentGenericService) throw new Error('通用设备运行时不可用');
            return currentGenericService.executeAiAction(
              {
                deviceId: action.target.deviceId,
                featureId: action.target.featureId,
                intensityCap: Math.min(action.target.capA, action.target.capB),
                allowEnhanced: masterGrant.allowEnhanced,
                durationMs: remaining,
                cadenceMs: masterGrant.cadenceMs,
                captureIntervalMs: masterGrant.captureIntervalMs,
              },
              {
                id: action.id,
                action: action.action === 'stop' ? 'stop' : 'start',
                intensity: action.value,
                outputLeaseMs: Math.min(loadDeviceSafety().maxBurstDurationMs, 5_000),
              },
            );
          }
          const target = service
            .getTargets()
            .find(
              (candidate) =>
                candidate.kind === action.target.kind &&
                candidate.targetId === action.target.targetId,
            );
          if (!target) throw new Error('授权物理目标已断开或身份已失效');
          return service.executeAiAction(
            target,
            {
              id: action.id,
              action: action.action,
              channel: action.channel,
              value: action.value,
              durationMs: action.durationMs,
            },
            {
              intensityCap: action.channel === 'A' ? action.target.capA : action.target.capB,
              allowEnhanced: masterGrant.allowEnhanced,
              allowBurst: masterGrant.allowBurst,
              durationMs: remaining,
              cadenceMs: masterGrant.cadenceMs,
              captureIntervalMs: masterGrant.captureIntervalMs,
            },
          );
        },
        stopAll: async () => {
          const currentGenericService = genericServiceSlot.get();
          const results = await Promise.allSettled([
            service.emergencyStop(),
            ...(currentGenericService ? [currentGenericService.emergencyStop()] : []),
          ]);
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (failure) throw failure.reason;
        },
      }),
  );
  const visionEnabled = Boolean(
    isVideoLlmConfigured(config) && llm?.capabilities?.imageInput === true,
  );
  const {
    videoRef,
    processedPreviewRef,
    state: cameraState,
    error: cameraError,
    start: startCamera,
    stop: stopCamera,
    capture: cameraCapture,
  } = useCameraPreview(facingMode, FIXED_CAMERA_FRAME_SETTINGS, invalidatePendingStart);

  const interpret = useCallback(
    async (image: Parameters<BrowserVideoControlService['observe']>[0], signal: AbortSignal) => {
      const text = await aiRouter.observe(image, signal);
      setObservations((current) => [...current, { step: current.length + 1, text }].slice(-20));
      return text;
    },
    [aiRouter],
  );

  const [session] = useState(
    () =>
      new VisualSession({
        capture: cameraCapture,
        interpret,
        stopAuthorizedTargets: async (reason) => {
          if (reason === 'emergency') return;
          try {
            await aiRouter.stop();
          } catch {
            setLocalError('无法确认设备已停止，请立即断开设备或取下电极');
          }
        },
        onChange: (snapshot) => {
          setVisual(snapshot);
          if (
            snapshot.stopReason &&
            snapshot.stopReason !== 'pause' &&
            snapshot.stopReason !== 'stop'
          ) {
            setRoutingGrant(null);
          }
        },
      }),
  );

  useEffect(() => {
    if (cameraState !== 'on') return;
    const timer = window.setTimeout(() => void session.captureNow(), 120);
    return () => window.clearTimeout(timer);
  }, [cameraState, session]);

  const emergencyStop = useCallback(async () => {
    startOperationRef.current += 1;
    autoStartRef.current = null;
    session.emergencyStop();
    setRoutingGrant(null);
    const results = await Promise.allSettled([aiRouter.emergencyStop()]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      setLocalError('无法确认设备已停止，请立即断开设备或取下电极');
      throw failure.reason;
    }
  }, [aiRouter, session]);

  useSafetySession({
    id: 'video',
    label: 'Video',
    // Generic devices are listed and stopped by the shell-owned runtime safety
    // session. Keep this module session responsible only for its legacy DG links.
    isActive: () => devices.coyotes.length > 0 || devices.opossumTarget !== null,
    stop: emergencyStop,
    connect: () => service.connect().then(() => undefined),
    disconnect: (deviceId) => service.disconnect(deviceId),
    onRevoke: async () => {
      startOperationRef.current += 1;
      autoStartRef.current = null;
      try {
        await aiRouter.stop();
      } finally {
        session.haltAfterExternalStop('lease-loss');
        setRoutingGrant(null);
      }
    },
    devices: () => service.getDeviceSummaries(safety),
  });

  useEffect(() => {
    if (!routingGrant || routingGrant.revoked) return;
    const live = new Set(outputTargetsRef.current.map(({ id }) => id));
    if (routingGrant.targets.some(({ id }) => !live.has(id))) {
      session.failSafeStop('device-loss');
      setRoutingGrant(null);
    }
  }, [devices, embeddedDevices, routingGrant, session]);

  useEffect(() => {
    if (
      (cameraState === 'off' || cameraState === 'error') &&
      (visual.status === 'running' || visual.status === 'paused' || routingGrant !== null)
    ) {
      startOperationRef.current += 1;
      autoStartRef.current = null;
      // VisualSession synchronously publishes the safety stop; its onChange
      // callback clears the routing grant snapshot in one place.
      session.failSafeStop('camera-ended');
    }
  }, [cameraState, routingGrant, session, visual.status]);

  const stopEverything = useCallback(
    (reason: 'hidden' | 'unmount' = 'hidden') => {
      startOperationRef.current += 1;
      autoStartRef.current = null;
      if (reason === 'hidden') session.failSafeStop('hidden');
      else session.stop('unmount');
      stopCamera();
    },
    [session, stopCamera],
  );
  const rootRef = useStopWhenModuleHidden(() => stopEverything('hidden'));

  useEffect(() => {
    const effectEpoch = ++lifecycleEffectRef.current;
    const lifecycleRef = lifecycleEffectRef;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopEverything('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopEverything('unmount');
      queueMicrotask(() => {
        // React StrictMode immediately replays effects with the same service instances.
        if (lifecycleRef.current !== effectEpoch) return;
        void service.dispose();
      });
    };
  }, [service, stopEverything]);

  const dgLabTargets = [
    ...devices.coyotes,
    ...(devices.opossumTarget ? [devices.opossumTarget] : []),
  ];
  const outputTargets = createUnifiedOutputTargets(
    dgLabTargets.map((target) => ({
      kind: target.kind,
      targetId: target.targetId,
      name: target.name,
      battery: target.state.battery,
      active:
        target.kind === 'coyote'
          ? target.state.strengthA > 0 || target.state.strengthB > 0
          : target.state.intensityA > 0 || target.state.intensityB > 0,
    })),
    genericService ? embeddedDevices : null,
  );
  const allowedTargets: VideoAiAllowedTarget[] = outputTargets.map((target) => ({
    ...target,
    capA: outputTargetSafetyControl(target, 'A', safety).max,
    capB: outputTargetSafetyControl(target, 'B', safety).max,
  }));
  const targetConnected = allowedTargets.length > 0;
  const activeGrant = routingGrant;
  useEffect(() => {
    outputTargetsRef.current = outputTargets;
    aiRouter.updateInputs(llm, outputTargets, embeddedScene);
  }, [aiRouter, embeddedScene, llm, outputTargets]);

  async function compensateCancelledStart() {
    try {
      await emergencyStop();
    } catch {
      // emergencyStop already reports and latches failures.
    }
  }

  async function authorizeControl(operation: number): Promise<VideoAiRoutingGrantSnapshot | null> {
    if (!targetConnected) {
      setLocalError('请选择输出功能');
      return null;
    }
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      if (operation !== startOperationRef.current) return null;
      const authorized = await aiRouter.authorize({
        targets: allowedTargets,
        allowEnhanced,
        allowBurst,
        durationMs: durationMinutes * 60_000,
        cadenceMs: cadenceSeconds * 1000,
        captureIntervalMs,
      });

      if (operation !== startOperationRef.current) {
        await compensateCancelledStart();
        return null;
      }
      setRoutingGrant(authorized);
      session.resetEmergencyLatch();
      return authorized;
    } catch (error) {
      if (operation === startOperationRef.current) {
        setLocalError(error instanceof Error ? error.message : '无法创建控制授权');
      }
      return null;
    }
  }

  async function startSession(
    authorizedGrant: VideoAiRoutingGrantSnapshot | null,
    now: number,
    operation: number,
  ) {
    if (cameraState !== 'on' || operation !== startOperationRef.current) return;
    if (!authorizedGrant || authorizedGrant.revoked || now >= authorizedGrant.expiresAt) {
      setLocalError('授权已失效');
      return;
    }
    try {
      setLocalError(null);
      if (visual.status !== 'paused') setObservations([]);
      if (operation !== startOperationRef.current) {
        await compensateCancelledStart();
        return;
      }
      session.start(
        authorizedGrant.cadenceMs,
        Math.max(1_000, authorizedGrant.expiresAt - now),
        authorizedGrant.captureIntervalMs,
      );
    } catch (error) {
      if (operation === startOperationRef.current) {
        setLocalError(error instanceof Error ? error.message : '无法开始视觉控制');
      }
    }
  }

  async function beginExperience() {
    if (!visionEnabled) {
      setLocalError('请先完成视觉模型设置');
      return;
    }
    const operation = ++startOperationRef.current;
    autoStartRef.current = operation;
    setRoutingGrant(null);
    setObservations([]);
    await startCamera();
  }

  useEffect(() => {
    const operation = autoStartRef.current;
    if (cameraState === 'on' && operation !== null) {
      autoStartRef.current = null;
      void authorizeControl(operation).then((authorized) => {
        if (authorized) return startSession(authorized, Date.now(), operation);
      });
    } else if (cameraState === 'error' && operation !== null) {
      startOperationRef.current += 1;
      autoStartRef.current = null;
    }
  });

  async function connect(kind: VideoOutputKind) {
    try {
      setLocalError(null);
      await service.connect(kind);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '设备连接失败');
    }
  }

  async function discoverEmbeddedDevices() {
    if (!genericDevicesEnabled || !genericService) return;
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      const snapshot = await genericService.discoverDevices();
      setEmbeddedDeviceState({ service: genericService, snapshot });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法查找通用嵌入设备');
    }
  }

  const error = localError ?? cameraError ?? visual.error;
  const frame = visual.latestFrame;
  const activateSetup = () => {
    if (visionEnabled && targetConnected) {
      void beginExperience();
      return;
    }
    startOperationRef.current += 1;
    autoStartRef.current = null;
    setRoutingGrant(null);
    void startCamera();
  };

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto min-h-full w-full max-w-[960px] p-4 md:p-6">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-hidden="true"
          className="pointer-events-none absolute h-px w-px opacity-0"
        />
        {cameraState === 'on' ? (
          <div className="flex flex-col gap-3">
            <CameraWorkbench
              processedPreviewRef={processedPreviewRef}
              cameraState={cameraState}
              latestFrame={frame}
              onStopCamera={() => {
                startOperationRef.current += 1;
                autoStartRef.current = null;
                session.failSafeStop('camera-ended');
                setRoutingGrant(null);
                stopCamera();
              }}
            />

            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3">
              <span className="mr-auto text-xs text-[var(--text-soft)]">
                {activeGrant ? `${statusLabel(visual)} · ${visual.steps} 次` : '摄像头预览'}
              </span>
              {activeGrant &&
                (visual.status === 'running' ? (
                  <Button size="sm" variant="secondary" onClick={() => session.pause()}>
                    <CirclePause className="h-4 w-4" /> 暂停
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      void startSession(activeGrant, Date.now(), startOperationRef.current)
                    }
                  >
                    <CirclePlay className="h-4 w-4" /> 继续
                  </Button>
                ))}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void emergencyStop().catch(() => undefined)}
              >
                <ShieldAlert className="h-4 w-4" /> 紧急停止
              </Button>
            </div>

            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            {observations.at(-1) && (
              <p className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-3 text-sm leading-relaxed">
                {observations.at(-1)?.text}
              </p>
            )}
          </div>
        ) : (
          <VideoSetupPanel
            view={{
              scenes: sceneOptions,
              selectedSceneId,
              facingMode,
              embeddedAvailable: genericDevicesEnabled && genericService !== null,
              showCoyoteConnect: service.supportsMultipleCoyotes() || devices.coyotes.length === 0,
              coyoteConnectLabel: devices.coyotes.length > 0 ? '添加郊狼' : '连接郊狼',
              showOpossumConnect: devices.opossumTarget === null,
              targets: outputTargets,
              durationMinutes,
              cadenceSeconds,
              allowEnhanced,
              allowBurst,
              visionEnabled,
              error,
              ctaLabel: visionEnabled && targetConnected ? '开启' : '预览摄像头',
              ctaDisabled: cameraState === 'starting',
            }}
            actions={{
              openVideoSettings: () => openSettings('ai-video'),
              openSceneSettings: () => openSettings('scenes'),
              selectScene: (id) =>
                updateSceneLibrary((current) => ({ ...current, selectedId: id })),
              setFacingMode,
              connect: (kind) => void connect(kind),
              discoverEmbeddedDevices: () => void discoverEmbeddedDevices(),
              setDurationMinutes,
              setCadenceSeconds,
              setAllowEnhanced,
              setAllowBurst,
              activate: activateSetup,
            }}
          />
        )}
      </div>
    </div>
  );
}

function statusLabel(snapshot: VisualSessionSnapshot): string {
  if (snapshot.requestInFlight) return '观察中';
  if (snapshot.emergencyLatched) return '紧急停止已锁定';
  const label = {
    idle: '未开始',
    running: '等待最新画面',
    paused: '已暂停',
    stopped: '已安全停止',
    error: '出错',
  }[snapshot.status];
  return snapshot.stopReason ? `${label}（${stopReasonLabel(snapshot.stopReason)}）` : label;
}

function stopReasonLabel(reason: NonNullable<VisualSessionSnapshot['stopReason']>): string {
  return {
    pause: '暂停',
    stop: '手动停止',
    hidden: '页面隐藏',
    'camera-ended': '摄像头结束',
    'device-loss': '设备断开',
    'grant-expired': '授权到期',
    watchdog: '观察超时',
    'model-failures': '模型连续失败',
    'lease-loss': '控制权已转移',
    unmount: '页面关闭',
    emergency: '紧急停止',
  }[reason];
}
