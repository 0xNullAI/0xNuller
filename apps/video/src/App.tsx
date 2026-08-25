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
import { grantDeviceLease } from '@dg-kit/safety';
import {
  createBrowserLlmClient,
  createBrowserVideoControl,
  type BrowserVideoControlService,
  type BrowserVideoDeviceSnapshot,
  type VideoOutputKind,
} from '@dg-agent/agent-browser';
import type { LlmClient } from '@dg-agent/core';
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
};

type GrantSnapshot = NonNullable<ReturnType<BrowserVideoControlService['getGrant']>>;

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
  const [targetKind, setTargetKind] = useState<VideoOutputKind>('coyote');
  const [channel, setChannel] = useState<'A' | 'B'>('A');
  const [intensityCap, setIntensityCap] = useState(10);
  const [allowEnhanced, setAllowEnhanced] = useState(false);
  const [allowBurst, setAllowBurst] = useState(false);
  const [grant, setGrant] = useState<GrantSnapshot | null>(null);
  const [devices, setDevices] = useState(EMPTY_DEVICE_SNAPSHOT);
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
      const text = await service.observe(image, signal);
      setObservations((current) => [...current, { step: current.length + 1, text }].slice(-20));
      return text;
    },
    [service],
  );

  const [session] = useState(
    () =>
      new VisualSession({
        capture: cameraCapture,
        interpret,
        stopAuthorizedTargets: async (reason) => {
          if (reason === 'emergency') return;
          try {
            await service.stop(reason as VisualSafetyStopReason);
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
    try {
      await service.emergencyStop();
    } catch (error) {
      setLocalError('无法确认设备已停止，请立即断开设备或取下电极');
      throw error;
    }
  }, [service, session]);

  useSafetySession({
    id: 'video',
    label: 'Video',
    isActive: () => devices.coyote.connected || devices.opossum.connected,
    stop: emergencyStop,
    connect: () => service.connect(),
    disconnect: (deviceId) => service.disconnect(deviceId === 'opossum' ? 'opossum' : 'coyote'),
    onRevoke: async () => {
      session.failSafeStop('lease-loss');
      await service.stop('lease-loss');
    },
    devices: () => service.getDeviceSummaries(safety),
  });

  useEffect(() => {
    if (!grant) return;
    const connected =
      grant.targetKind === 'coyote' ? devices.coyote.connected : devices.opossum.connected;
    if (!connected) session.failSafeStop('device-loss');
  }, [devices.coyote.connected, devices.opossum.connected, grant, session]);

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
    };
  }, [service, stopEverything]);

  const targetConnected =
    targetKind === 'coyote' ? devices.coyote.connected : devices.opossum.connected;
  const targetSafetyCap =
    targetKind === 'coyote'
      ? channel === 'A'
        ? safety.maxStrengthA
        : safety.maxStrengthB
      : channel === 'A'
        ? safety.maxIntensityA
        : safety.maxIntensityB;

  const effectiveIntensityCap = Math.min(Math.max(0, intensityCap), targetSafetyCap);

  async function authorizeControl() {
    if (!targetConnected) {
      setLocalError('请先连接要授权的输出设备');
      return;
    }
    try {
      setLocalError(null);
      await grantDeviceLease('video');
      const next = await service.authorize({
        targetKind,
        channel,
        intensityCap: effectiveIntensityCap,
        allowEnhanced,
        allowBurst,
        durationMs: durationMinutes * 60_000,
        cadenceMs: cadenceSeconds * 1000,
        captureIntervalMs,
      });
      session.resetEmergencyLatch();
      setGrant(next);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '无法创建控制授权');
    }
  }

  async function startSession() {
    if (cameraState !== 'on') {
      setLocalError('请先开启摄像头并确认实时预览');
      return;
    }
    if (!grant || grant.revoked || Date.now() >= grant.expiresAt) {
      setLocalError('请先确认目标、通道与上限并授权');
      return;
    }
    try {
      setLocalError(null);
      if (visual.status !== 'paused') setObservations([]);
      service.beginRun();
      session.start(
        grant.cadenceMs,
        Math.max(1_000, grant.expiresAt - Date.now()),
        grant.captureIntervalMs,
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
      await service.connect(kind);
      setTargetKind(kind);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '设备连接失败');
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">设备授权</span>
              <div className="flex gap-1.5">
                {!devices.coyote.connected && (
                  <Button size="sm" variant="secondary" onClick={() => void connect('coyote')}>
                    <Link className="h-3.5 w-3.5" /> 郊狼
                  </Button>
                )}
                {!devices.opossum.connected && (
                  <Button size="sm" variant="secondary" onClick={() => void connect('opossum')}>
                    <Link className="h-3.5 w-3.5" /> 负鼠
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-[var(--text-soft)]">
                目标
                <select
                  value={targetKind}
                  onChange={(event) => setTargetKind(event.target.value as VideoOutputKind)}
                  disabled={visual.status === 'running'}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-2"
                >
                  <option value="coyote">郊狼{devices.coyote.connected ? ' · 已连接' : ''}</option>
                  <option value="opossum">
                    负鼠{devices.opossum.connected ? ' · 已连接' : ''}
                  </option>
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
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowBurst}
                  onChange={(event) => setAllowBurst(event.target.checked)}
                  disabled={visual.status === 'running'}
                />
                允许短时脉冲
              </label>
            </div>

            <Button
              variant={grant ? 'secondary' : 'default'}
              onClick={() => void authorizeControl()}
              disabled={!visionEnabled || !targetConnected || visual.status === 'running'}
            >
              {grant ? '重新授权' : '确认并授权'}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {visual.status === 'running' ? (
              <Button variant="secondary" onClick={() => session.pause()}>
                <CirclePause className="h-4 w-4" /> 暂停
              </Button>
            ) : (
              <Button onClick={() => void startSession()} disabled={!grant || cameraState !== 'on'}>
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
            {grant && !grant.revoked
              ? ` · 授权至 ${new Date(grant.expiresAt).toLocaleTimeString()}`
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
