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
import { useNativeBridge } from '@0xnullai/native';
import { useScenes } from '@0xnullai/scenes/react';
import { grantDeviceLease, hasDeviceLease } from '@dg-kit/safety';
import type { DeviceSnapshot } from '@0xnullai/device-runtime';
import {
  createBrowserLlmClient,
  createBrowserVideoControl,
  type BrowserVideoControlService,
  type BrowserVideoDeviceSnapshot,
  type VideoOutputKind,
} from '@dg-agent/agent-browser';
import type { LlmClient } from '@dg-agent/core';
import { getAnyPromptPresetById } from '@dg-agent/runtime';
import { CameraWorkbench } from './components/CameraWorkbench.js';
import { VideoSetupPanel, type VideoTargetFamily } from './components/VideoSetupPanel.js';
import { useCameraPreview, type CameraFacingMode } from './hooks/use-camera-preview.js';
import { DEFAULT_CAMERA_FRAME_SETTINGS } from './services/camera-frame.js';
import {
  VisualSession,
  type VisualSafetyStopReason,
  type VisualSessionSnapshot,
} from './services/visual-session.js';
import {
  DeviceRuntimeVideoControlService,
  type DeviceRuntimeVideoGrantSnapshot,
} from './services/device-runtime-video-control.js';

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

type GrantSnapshot = NonNullable<ReturnType<BrowserVideoControlService['getGrant']>>;
type ActiveGrantSnapshot = GrantSnapshot | DeviceRuntimeVideoGrantSnapshot;
const FIXED_CAMERA_FRAME_SETTINGS = Object.freeze({
  ...DEFAULT_CAMERA_FRAME_SETTINGS,
  cropPreset: '16:9' as const,
  outputMaxEdge: 768,
});

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
  const [sceneLibrary] = useScenes();
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [cadenceSeconds, setCadenceSeconds] = useState(10);
  const captureIntervalMs = 1_000;
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [targetFamily, setTargetFamily] = useState<VideoTargetFamily>('dg-lab');
  const [targetKind, setTargetKind] = useState<VideoOutputKind>('coyote');
  const [targetId, setTargetId] = useState('');
  const [embeddedDeviceId, setEmbeddedDeviceId] = useState('');
  const [embeddedFeatureId, setEmbeddedFeatureId] = useState('');
  const [channel, setChannel] = useState<'A' | 'B'>('A');
  const [intensityCap, setIntensityCap] = useState(10);
  const [embeddedIntensityCap, setEmbeddedIntensityCap] = useState(0.2);
  const [allowEnhanced, setAllowEnhanced] = useState(false);
  const [allowBurst, setAllowBurst] = useState(false);
  const [grant, setGrant] = useState<GrantSnapshot | null>(null);
  const [embeddedGrant, setEmbeddedGrant] = useState<DeviceRuntimeVideoGrantSnapshot | null>(null);
  const [devices, setDevices] = useState(EMPTY_DEVICE_SNAPSHOT);
  const [embeddedDevices, setEmbeddedDevices] = useState<DeviceSnapshot | null>(null);
  const [visual, setVisual] = useState(INITIAL_VISUAL_STATE);
  const [observations, setObservations] = useState<Array<{ step: number; text: string }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const startOperationRef = useRef(0);
  const autoStartRef = useRef<number | null>(null);
  const lifecycleEffectRef = useRef(0);
  const invalidatePendingStart = useCallback(() => {
    startOperationRef.current += 1;
    autoStartRef.current = null;
  }, []);
  const openSettings = useOpenShellSettings();
  const native = useNativeBridge();
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
  const genericService = useMemo(
    () =>
      native.deviceRuntime
        ? new DeviceRuntimeVideoControlService({
            provider: native.deviceRuntime,
            llm: null,
            scene: null,
            hasLease: () => hasDeviceLease('video'),
            getSafetyIntensityCap: () => {
              const current = loadDeviceSafety();
              return Math.min(current.maxIntensityA, current.maxIntensityB) / 200;
            },
            getMaxOutputLeaseMs: () =>
              Math.min(5_000, Math.max(1, loadDeviceSafety().maxBurstDurationMs)),
          })
        : null,
    [native.deviceRuntime],
  );
  useEffect(() => {
    genericService?.updateInputs({ llm, scene: embeddedScene });
  }, [embeddedScene, genericService, llm]);
  useEffect(() => {
    if (!genericService) return;
    return genericService.subscribe(setEmbeddedDevices);
  }, [genericService]);
  const currentControl = useCallback((): VideoTargetFamily | null => {
    const now = Date.now();
    const genericGrant = genericService?.getGrant();
    if (genericGrant && !genericGrant.revoked && now < genericGrant.expiresAt) return 'embedded';
    const dgLabGrant = service.getGrant();
    if (dgLabGrant && !dgLabGrant.revoked && now < dgLabGrant.expiresAt) return 'dg-lab';
    return null;
  }, [genericService, service]);

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
      const text =
        currentControl() === 'embedded'
          ? await genericService!.observe(image, signal)
          : await service.observe(image, signal);
      setObservations((current) => [...current, { step: current.length + 1, text }].slice(-20));
      return text;
    },
    [currentControl, genericService, service],
  );

  const [session] = useState(
    () =>
      new VisualSession({
        capture: cameraCapture,
        interpret,
        stopAuthorizedTargets: async (reason) => {
          if (reason === 'emergency') return;
          try {
            if (currentControl() === 'embedded') {
              await genericService?.stop(reason as VisualSafetyStopReason);
            } else {
              await service.stop(reason as VisualSafetyStopReason);
            }
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
            setGrant(null);
            setEmbeddedGrant(null);
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
    setGrant(null);
    setEmbeddedGrant(null);
    const results = await Promise.allSettled([
      service.emergencyStop(),
      ...(genericService ? [genericService.emergencyStop()] : []),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) {
      setLocalError('无法确认设备已停止，请立即断开设备或取下电极');
      throw failure.reason;
    }
  }, [genericService, service, session]);

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
      session.failSafeStop('lease-loss');
      const results = await Promise.allSettled([
        service.stop('lease-loss'),
        ...(genericService ? [genericService.stop('lease-loss')] : []),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    },
    devices: () => service.getDeviceSummaries(safety),
  });

  useEffect(() => {
    if (!grant) return;
    const connected = [
      ...devices.coyotes,
      ...(devices.opossumTarget ? [devices.opossumTarget] : []),
    ].some((target) => target.kind === grant.targetKind && target.targetId === grant.targetId);
    if (!connected) session.failSafeStop('device-loss');
  }, [devices.coyotes, devices.opossumTarget, grant, session]);

  useEffect(() => {
    if (!embeddedGrant) return;
    const connected = embeddedDevices?.devices.some(
      (device) =>
        device.deviceId === embeddedGrant.deviceId &&
        device.capabilities.some(
          (feature) => feature.kind === 'vibrate' && feature.featureId === embeddedGrant.featureId,
        ),
    );
    if (!connected) session.failSafeStop('device-loss');
  }, [embeddedDevices, embeddedGrant, session]);

  useEffect(() => {
    if (
      (cameraState === 'off' || cameraState === 'error') &&
      (visual.status === 'running' ||
        visual.status === 'paused' ||
        grant !== null ||
        embeddedGrant !== null)
    ) {
      startOperationRef.current += 1;
      autoStartRef.current = null;
      // VisualSession synchronously publishes the safety stop; its onChange
      // callback clears both grant snapshots in one place.
      session.failSafeStop('camera-ended');
    }
  }, [cameraState, embeddedGrant, grant, session, visual.status]);

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
        void genericService?.dispose();
      });
    };
  }, [genericService, service, stopEverything]);

  const connectedTargets = [
    ...devices.coyotes,
    ...(devices.opossumTarget ? [devices.opossumTarget] : []),
  ];
  const selectedTarget = connectedTargets.find(
    (target) => target.kind === targetKind && target.targetId === targetId,
  );
  const embeddedTargets =
    embeddedDevices?.devices.flatMap((device) =>
      device.capabilities.flatMap((feature) =>
        feature.kind === 'vibrate'
          ? [
              {
                deviceId: device.deviceId,
                featureId: feature.featureId,
                name: device.name,
                feature,
              },
            ]
          : [],
      ),
    ) ?? [];
  const selectedEmbeddedTarget = embeddedTargets.find(
    (target) => target.deviceId === embeddedDeviceId && target.featureId === embeddedFeatureId,
  );
  const targetConnected =
    targetFamily === 'embedded'
      ? selectedEmbeddedTarget !== undefined
      : selectedTarget !== undefined;
  const targetSafetyCap =
    targetKind === 'coyote'
      ? channel === 'A'
        ? safety.maxStrengthA
        : safety.maxStrengthB
      : channel === 'A'
        ? safety.maxIntensityA
        : safety.maxIntensityB;

  const effectiveIntensityCap = Math.min(Math.max(0, intensityCap), targetSafetyCap);
  const embeddedSafetyCap = Math.min(safety.maxIntensityA, safety.maxIntensityB) / 200;
  const effectiveEmbeddedIntensityCap = Math.min(
    embeddedSafetyCap,
    Math.max(0, embeddedIntensityCap),
  );
  const activeGrant = targetFamily === 'embedded' ? embeddedGrant : grant;

  async function stopPreviousControl(next: VideoTargetFamily) {
    const current = currentControl();
    if (!current || current === next) return;
    if (current === 'embedded') await genericService?.stop('device-loss');
    else await service.stop('device-loss');
    setGrant(null);
    setEmbeddedGrant(null);
  }

  async function compensateCancelledStart() {
    try {
      await emergencyStop();
    } catch {
      // emergencyStop already reports and latches failures.
    }
  }

  async function authorizeControl(operation: number): Promise<ActiveGrantSnapshot | null> {
    if (!targetConnected) {
      setLocalError('请选择输出功能');
      return null;
    }
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      if (operation !== startOperationRef.current) return null;
      await stopPreviousControl(targetFamily);
      if (operation !== startOperationRef.current) return null;

      let authorized: ActiveGrantSnapshot;
      if (targetFamily === 'embedded') {
        if (!genericService || !selectedEmbeddedTarget) throw new Error('通用设备运行时不可用');
        authorized = await genericService.authorize({
          deviceId: selectedEmbeddedTarget.deviceId,
          featureId: selectedEmbeddedTarget.featureId,
          intensityCap: effectiveEmbeddedIntensityCap,
          allowEnhanced,
          durationMs: durationMinutes * 60_000,
          cadenceMs: cadenceSeconds * 1000,
          captureIntervalMs,
        });
      } else {
        authorized = await service.authorize({
          targetKind,
          targetId,
          channel,
          intensityCap: effectiveIntensityCap,
          allowEnhanced,
          allowBurst,
          durationMs: durationMinutes * 60_000,
          cadenceMs: cadenceSeconds * 1000,
          captureIntervalMs,
        });
      }

      if (operation !== startOperationRef.current) {
        await compensateCancelledStart();
        return null;
      }
      if (targetFamily === 'embedded') {
        setGrant(null);
        setEmbeddedGrant(authorized as DeviceRuntimeVideoGrantSnapshot);
      } else {
        setEmbeddedGrant(null);
        setGrant(authorized as GrantSnapshot);
      }
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
    authorizedGrant: ActiveGrantSnapshot | null,
    now: number,
    operation: number,
  ) {
    if (cameraState !== 'on' || operation !== startOperationRef.current) return;
    if (!authorizedGrant || authorizedGrant.revoked || now >= authorizedGrant.expiresAt) {
      setLocalError('授权已失效');
      return;
    }
    if (currentControl() !== targetFamily) {
      setLocalError('当前目标尚未获得本次 Video 授权');
      return;
    }
    try {
      setLocalError(null);
      if (visual.status !== 'paused') setObservations([]);
      if (targetFamily === 'embedded') await genericService!.beginRun();
      else service.beginRun();
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
    setGrant(null);
    setEmbeddedGrant(null);
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
      const target = await service.connect(kind);
      setTargetFamily('dg-lab');
      setTargetKind(target.kind);
      setTargetId(target.targetId);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '设备连接失败');
    }
  }

  async function discoverEmbeddedDevices() {
    if (!genericService) return;
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      const snapshot = await genericService.discoverDevices();
      setEmbeddedDevices(snapshot);
      const first = snapshot.devices.flatMap((device) =>
        device.capabilities.flatMap((feature) =>
          feature.kind === 'vibrate'
            ? [{ deviceId: device.deviceId, featureId: feature.featureId }]
            : [],
        ),
      )[0];
      if (first) {
        setEmbeddedDeviceId(first.deviceId);
        setEmbeddedFeatureId(first.featureId);
      }
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
    setGrant(null);
    setEmbeddedGrant(null);
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
                setGrant(null);
                setEmbeddedGrant(null);
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
              facingMode,
              targetFamily,
              embeddedAvailable: genericService !== null,
              showCoyoteConnect: service.supportsMultipleCoyotes() || devices.coyotes.length === 0,
              coyoteConnectLabel: devices.coyotes.length > 0 ? '添加郊狼' : '连接郊狼',
              showOpossumConnect: devices.opossumTarget === null,
              targetOptions: connectedTargets.map((target) => ({
                value: target.targetId,
                label: `${target.kind === 'coyote' ? '郊狼' : '负鼠'} · ${target.name}`,
              })),
              selectedTargetId: targetId,
              channel,
              embeddedFeatureOptions: embeddedTargets.map((target, index) => ({
                value: target.featureId,
                label: `${target.name} · 振动 ${index + 1}`,
              })),
              selectedEmbeddedFeatureId: embeddedFeatureId,
              intensityLabel:
                targetFamily === 'embedded'
                  ? `${Math.round(effectiveEmbeddedIntensityCap * 100)}%`
                  : `${effectiveIntensityCap}/${targetSafetyCap}`,
              intensityMax: targetFamily === 'embedded' ? 1 : targetSafetyCap,
              intensityStep: targetFamily === 'embedded' ? 0.01 : 1,
              intensityValue:
                targetFamily === 'embedded' ? effectiveEmbeddedIntensityCap : effectiveIntensityCap,
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
              setFacingMode,
              setTargetFamily,
              connect: (kind) => void connect(kind),
              discoverEmbeddedDevices: () => void discoverEmbeddedDevices(),
              selectTarget: (nextTargetId) => {
                const nextTarget = connectedTargets.find(
                  (target) => target.targetId === nextTargetId,
                );
                setTargetId(nextTargetId);
                if (nextTarget) setTargetKind(nextTarget.kind);
              },
              selectEmbeddedFeature: (nextFeatureId) => {
                const next = embeddedTargets.find((target) => target.featureId === nextFeatureId);
                setEmbeddedFeatureId(nextFeatureId);
                if (next) setEmbeddedDeviceId(next.deviceId);
              },
              setChannel,
              setIntensity: (value) => {
                if (targetFamily === 'embedded') setEmbeddedIntensityCap(value);
                else setIntensityCap(value);
              },
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
