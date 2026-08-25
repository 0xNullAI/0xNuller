import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePause, CirclePlay, Link, Settings, ShieldAlert } from 'lucide-react';
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
import { useCameraPreview, type CameraFacingMode } from './hooks/use-camera-preview.js';
import {
  DEFAULT_CAMERA_FRAME_SETTINGS,
  type CameraFrameSettings,
} from './services/camera-frame.js';
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
type VideoTargetFamily = 'dg-lab' | 'embedded';

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
  const [frameSettings, setFrameSettings] = useState<CameraFrameSettings>(() => ({
    ...DEFAULT_CAMERA_FRAME_SETTINGS,
  }));
  const [cadenceSeconds, setCadenceSeconds] = useState(10);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(1_000);
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
  } = useCameraPreview(visionEnabled, facingMode, frameSettings);

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
  }, [cameraState, frameSettings, session]);

  const emergencyStop = useCallback(async () => {
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
    if ((cameraState === 'off' || cameraState === 'error') && visual.status === 'running') {
      session.failSafeStop('camera-ended');
    }
  }, [cameraState, session, visual.status]);

  const stopEverything = useCallback(
    (reason: 'hidden' | 'unmount' = 'hidden') => {
      if (reason === 'hidden') session.failSafeStop('hidden');
      else session.stop('unmount');
      stopCamera();
    },
    [session, stopCamera],
  );
  const rootRef = useStopWhenModuleHidden(() => stopEverything('hidden'));

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopEverything('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopEverything('unmount');
      void service.dispose();
      void genericService?.dispose();
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

  async function authorizeControl() {
    if (!targetConnected) {
      setLocalError('请先选择要授权的输出功能');
      return;
    }
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      await stopPreviousControl(targetFamily);
      if (targetFamily === 'embedded') {
        if (!genericService || !selectedEmbeddedTarget) throw new Error('通用设备运行时不可用');
        const next = await genericService.authorize({
          deviceId: selectedEmbeddedTarget.deviceId,
          featureId: selectedEmbeddedTarget.featureId,
          intensityCap: effectiveEmbeddedIntensityCap,
          allowEnhanced,
          durationMs: durationMinutes * 60_000,
          cadenceMs: cadenceSeconds * 1000,
          captureIntervalMs,
        });
        setGrant(null);
        setEmbeddedGrant(next);
      } else {
        const next = await service.authorize({
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
        setEmbeddedGrant(null);
        setGrant(next);
      }
      session.resetEmergencyLatch();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法创建控制授权');
    }
  }

  async function startSession() {
    if (cameraState !== 'on') {
      setLocalError('请先开启摄像头并确认实时预览');
      return;
    }
    if (!activeGrant || activeGrant.revoked || Date.now() >= activeGrant.expiresAt) {
      setLocalError('请先确认目标、功能与上限并授权');
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
      session.start(
        activeGrant.cadenceMs,
        Math.max(1_000, activeGrant.expiresAt - Date.now()),
        activeGrant.captureIntervalMs,
      );
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法开始视觉控制');
    }
  }

  async function captureManually() {
    if (cameraState !== 'on') {
      setLocalError('请先开启摄像头');
      return;
    }
    setLocalError(null);
    await session.captureNow();
  }

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

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto grid min-h-full w-full max-w-[1180px] gap-5 p-4 md:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)] md:p-6">
        <CameraWorkbench
          videoRef={videoRef}
          processedPreviewRef={processedPreviewRef}
          cameraState={cameraState}
          visionEnabled={visionEnabled}
          facingMode={facingMode}
          settings={frameSettings}
          latestFrame={frame}
          onFacingModeChange={setFacingMode}
          onSettingsChange={setFrameSettings}
          onStartCamera={() => void startCamera()}
          onStopCamera={() => stopEverything('hidden')}
          onCapture={() => void captureManually()}
        />

        <aside className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">视觉控制</h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
                每次授权最长 15 分钟。新画面替换旧画面，图片不会保存、同步或进入历史。
              </p>
            </div>
            <button
              type="button"
              onClick={() => openSettings('ai-video')}
              aria-label="打开 AI 设置"
              className="rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] hover:bg-[var(--bg-soft)]"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3">
            <label className="grid gap-1 text-xs text-[var(--text-soft)]">
              输出类型
              <select
                value={targetFamily}
                onChange={(event) => setTargetFamily(event.target.value as VideoTargetFamily)}
                disabled={visual.status === 'running'}
                className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
              >
                <option value="dg-lab">郊狼 / 负鼠</option>
                {genericService && <option value="embedded">通用嵌入设备</option>}
              </select>
            </label>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">设备授权</span>
              <div className="flex gap-1.5">
                {targetFamily === 'embedded' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void discoverEmbeddedDevices()}
                    disabled={visual.status === 'running'}
                  >
                    <Link className="h-3.5 w-3.5" /> 查找设备
                  </Button>
                ) : (
                  <>
                    {(service.supportsMultipleCoyotes() || devices.coyotes.length === 0) && (
                      <Button size="sm" variant="secondary" onClick={() => void connect('coyote')}>
                        <Link className="h-3.5 w-3.5" />
                        {devices.coyotes.length > 0 ? '添加郊狼' : '郊狼'}
                      </Button>
                    )}
                    {!devices.opossumTarget && (
                      <Button size="sm" variant="secondary" onClick={() => void connect('opossum')}>
                        <Link className="h-3.5 w-3.5" /> 负鼠
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            {targetFamily === 'embedded' ? (
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                通用振动功能
                <select
                  value={embeddedFeatureId}
                  onChange={(event) => {
                    const next = embeddedTargets.find(
                      (target) => target.featureId === event.target.value,
                    );
                    setEmbeddedFeatureId(event.target.value);
                    if (next) setEmbeddedDeviceId(next.deviceId);
                  }}
                  disabled={visual.status === 'running'}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                >
                  <option value="">请选择已发现的振动功能</option>
                  {embeddedTargets.map((target, index) => (
                    <option key={target.featureId} value={target.featureId}>
                      {target.name} · 振动 {index + 1} · {target.deviceId}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                  目标
                  <select
                    value={targetId}
                    onChange={(event) => {
                      const nextTarget = connectedTargets.find(
                        (target) => target.targetId === event.target.value,
                      );
                      setTargetId(event.target.value);
                      if (nextTarget) setTargetKind(nextTarget.kind);
                    }}
                    disabled={visual.status === 'running'}
                    className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                  >
                    <option value="">请选择已连接目标</option>
                    {connectedTargets.map((target) => (
                      <option key={target.targetId} value={target.targetId}>
                        {target.kind === 'coyote' ? '郊狼' : '负鼠'} · {target.name} ·{' '}
                        {target.targetId}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                  通道
                  <select
                    value={channel}
                    onChange={(event) => setChannel(event.target.value as 'A' | 'B')}
                    disabled={visual.status === 'running'}
                    className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </label>
              </div>
            )}

            {targetFamily === 'embedded' ? (
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                归一化强度上限 · {Math.round(effectiveEmbeddedIntensityCap * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={effectiveEmbeddedIntensityCap}
                  onChange={(event) => setEmbeddedIntensityCap(Number(event.target.value))}
                  disabled={visual.status === 'running'}
                />
              </label>
            ) : (
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                强度上限 · {effectiveIntensityCap}/{targetSafetyCap}
                <input
                  type="range"
                  min={0}
                  max={targetSafetyCap}
                  value={effectiveIntensityCap}
                  onChange={(event) => setIntensityCap(Number(event.target.value))}
                  disabled={visual.status === 'running'}
                />
              </label>
            )}

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                授权时长
                <select
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(Number(event.target.value))}
                  disabled={visual.status === 'running'}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                >
                  {[1, 5, 10, 15].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} 分钟
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                模型节奏
                <select
                  value={cadenceSeconds}
                  onChange={(event) => setCadenceSeconds(Number(event.target.value))}
                  disabled={visual.status === 'running'}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                >
                  <option value={5}>5 秒</option>
                  <option value={10}>10 秒</option>
                  <option value={15}>15 秒</option>
                  <option value={30}>30 秒</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                最新帧刷新
                <select
                  value={captureIntervalMs}
                  onChange={(event) => setCaptureIntervalMs(Number(event.target.value))}
                  disabled={visual.status === 'running'}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                >
                  <option value={200}>0.2 秒</option>
                  <option value={500}>0.5 秒</option>
                  <option value={1000}>1 秒</option>
                  <option value={2000}>2 秒</option>
                  <option value={5000}>5 秒</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-4 text-xs text-[var(--text-soft)]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowEnhanced}
                  onChange={(event) => setAllowEnhanced(event.target.checked)}
                  disabled={visual.status === 'running'}
                />
                允许小步增强
              </label>
              {targetFamily === 'dg-lab' && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowBurst}
                    onChange={(event) => setAllowBurst(event.target.checked)}
                    disabled={visual.status === 'running'}
                  />
                  允许短时脉冲
                </label>
              )}
            </div>

            <Button
              variant={activeGrant ? 'secondary' : 'default'}
              onClick={() => void authorizeControl()}
              disabled={!visionEnabled || !targetConnected || visual.status === 'running'}
            >
              {activeGrant ? '重新授权' : '确认并授权'}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {visual.status === 'running' ? (
              <Button variant="secondary" onClick={() => session.pause()}>
                <CirclePause className="h-4 w-4" /> 暂停
              </Button>
            ) : (
              <Button
                onClick={() => void startSession()}
                disabled={!activeGrant || cameraState !== 'on'}
              >
                <CirclePlay className="h-4 w-4" />
                {visual.status === 'paused' ? '继续' : '开始'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => session.stop()}
              disabled={visual.status === 'idle'}
            >
              停止
            </Button>
            <Button
              variant="destructive"
              onClick={() => void emergencyStop().catch(() => undefined)}
            >
              <ShieldAlert className="h-4 w-4" /> 紧急停止
            </Button>
          </div>

          <div className="rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-soft)]">
            状态：{statusLabel(visual)} · {visual.steps} 次观察
            {activeGrant && !activeGrant.revoked
              ? ` · 目标 ${targetFamily === 'embedded' ? embeddedGrant?.featureId : grant?.targetId} · 授权至 ${new Date(activeGrant.expiresAt).toLocaleTimeString()}`
              : ' · 未授权'}
          </div>

          {!visionEnabled && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--accent-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
              当前文本模型未明确支持图片输入。请在 AI 设置中选择受支持的视觉模型。
            </p>
          )}
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="min-h-[120px] flex-1 space-y-3 overflow-y-auto">
            {observations.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--text-faint)]">
                场景回应仅保留在当前页面
              </p>
            ) : (
              observations.map((observation) => (
                <article
                  key={observation.step}
                  className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
                >
                  <div className="mb-1 text-xs font-medium text-[var(--accent-strong)]">
                    第 {observation.step} 次
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{observation.text}</p>
                </article>
              ))
            )}
          </div>
        </aside>
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

export default App;
