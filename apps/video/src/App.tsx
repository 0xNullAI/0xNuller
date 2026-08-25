import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  CirclePause,
  CirclePlay,
  ScanEye,
  Settings,
  SwitchCamera,
} from 'lucide-react';
import { Button, useOpenShellSettings } from '@0xnullai/ui';
import {
  isLlmConfigured,
  loadLlmConfig,
  normalizeProviderSettings,
  subscribeLlmConfig,
  type LlmConfig,
  type ProviderId,
} from '@0xnullai/llm-providers';
import { createBrowserLlmClient } from '@dg-agent/agent-browser';
import { createEmptyDeviceState, type LlmClient, type LlmImageInput } from '@dg-agent/core';
import { useCameraPreview, type CameraFacingMode } from './hooks/use-camera-preview.js';
import {
  VisualSession,
  VISUAL_SESSION_MAX_STEPS,
  type VisualSessionSnapshot,
} from './services/visual-session.js';

const INITIAL_VISUAL_STATE: VisualSessionSnapshot = {
  status: 'idle',
  steps: 0,
  requestInFlight: false,
  latestFrame: null,
  latestExplanation: '',
  error: null,
};

function llmForConfig(config: LlmConfig): LlmClient {
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
  const [config, setConfig] = useState(loadLlmConfig);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [intervalSeconds, setIntervalSeconds] = useState(15);
  const [visual, setVisual] = useState(INITIAL_VISUAL_STATE);
  const [observations, setObservations] = useState<Array<{ step: number; text: string }>>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const openSettings = useOpenShellSettings();

  useEffect(() => subscribeLlmConfig(setConfig), []);

  const llm = useMemo(() => {
    try {
      return llmForConfig(config);
    } catch {
      return null;
    }
  }, [config]);
  const visionEnabled = Boolean(isLlmConfigured(config) && llm?.capabilities?.imageInput === true);
  const {
    videoRef,
    state: cameraState,
    error: cameraError,
    start: startCamera,
    stop: stopCamera,
    capture: cameraCapture,
  } = useCameraPreview(visionEnabled, facingMode);

  const interpret = useCallback(
    async (image: LlmImageInput, signal: AbortSignal) => {
      if (!llm?.capabilities?.imageInput) throw new Error('当前模型未声明图片输入能力');
      const now = Date.now();
      const prompt = '请解释当前画面中可直接观察到的内容与变化；不确定的信息请明确说明。';
      const result = await llm.runTurn({
        session: {
          id: 'video-ephemeral',
          createdAt: now,
          updatedAt: now,
          messages: [],
          deviceState: createEmptyDeviceState(),
        },
        message: prompt,
        context: { sessionId: 'video-ephemeral', sourceType: 'web', traceId: `video-${now}` },
        instructions:
          '你是只读视觉解释器。仅描述画面中可见内容，不推断身份或敏感属性，不请求或调用任何工具。回答简洁、具体。',
        tools: [],
        image,
        abortSignal: signal,
        conversation: [{ kind: 'message', role: 'user', content: prompt }],
      });
      const text = result.assistantMessage.trim() || '模型未返回文字说明';
      setObservations((current) =>
        [...current, { step: current.length + 1, text }].slice(-VISUAL_SESSION_MAX_STEPS),
      );
      return text;
    },
    [llm],
  );

  const session = useMemo(
    () =>
      new VisualSession({
        capture: cameraCapture,
        interpret,
        onChange: (snapshot) => setVisual({ ...snapshot }),
      }),
    [cameraCapture, interpret],
  );

  useEffect(() => {
    if (cameraState === 'off' || cameraState === 'error') session.stop();
  }, [cameraState, session]);

  const stopEverything = useCallback(() => {
    session.stop();
    stopCamera();
  }, [session, stopCamera]);
  const rootRef = useStopWhenModuleHidden(stopEverything);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopEverything();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopEverything();
    };
  }, [stopEverything]);

  function startSession() {
    if (cameraState !== 'on') {
      setLocalError('请先开启摄像头并确认实时预览');
      return;
    }
    setLocalError(null);
    if (visual.status !== 'paused') setObservations([]);
    session.start(intervalSeconds * 1000);
  }

  async function captureManually() {
    if (cameraState !== 'on') {
      setLocalError('请先开启摄像头');
      return;
    }
    setLocalError(null);
    await session.captureNow();
  }

  const error = localError ?? cameraError ?? visual.error;
  const frame = visual.latestFrame;

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto grid min-h-full w-full max-w-[1100px] gap-5 p-4 md:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)] md:p-6">
        <section className="flex min-h-[420px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--surface-border)] px-4 py-3">
            <div>
              <h1 className="font-semibold">Video</h1>
              <p className="text-xs text-[var(--text-faint)]">短时、只读的实时视觉解释</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-[var(--text-soft)]">
                镜头
                <select
                  value={facingMode}
                  onChange={(event) => setFacingMode(event.target.value as CameraFacingMode)}
                  className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-2 py-1.5"
                >
                  <option value="environment">后置</option>
                  <option value="user">前置</option>
                </select>
              </label>
              <SwitchCamera className="h-4 w-4 text-[var(--text-faint)]" aria-hidden />
            </div>
          </header>

          <div className="relative flex min-h-[300px] flex-1 items-center justify-center bg-black">
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label="实时摄像头预览"
              className="h-full max-h-[70dvh] w-full object-contain"
            />
            {cameraState !== 'on' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center text-white">
                <Camera className="h-9 w-9 opacity-75" />
                <p className="text-sm">
                  {cameraState === 'starting' ? '正在请求摄像头…' : '摄像头保持关闭'}
                </p>
                <Button
                  onClick={() => void startCamera()}
                  disabled={!visionEnabled || cameraState === 'starting'}
                >
                  开启摄像头
                </Button>
              </div>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--surface-border)] p-3">
            {cameraState === 'on' ? (
              <Button variant="secondary" onClick={stopEverything}>
                <CameraOff className="h-4 w-4" /> 关闭
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => void captureManually()}
              disabled={cameraState !== 'on'}
            >
              <ScanEye className="h-4 w-4" /> 手动采集
            </Button>
            <span className="ml-auto text-xs text-[var(--text-faint)]">
              {frame
                ? `最新帧 ${new Date(frame.capturedAt).toLocaleTimeString()} · ${frame.width}×${frame.height} · ${Math.ceil(frame.byteLength / 1024)}KB`
                : '尚未采集画面'}
            </span>
          </footer>
        </section>

        <aside className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">视觉解释</h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
                每次最多 3 步、90 秒；请求间隔不少于 10 秒。画面不会保存或同步。
              </p>
            </div>
            <button
              type="button"
              onClick={() => openSettings('ai')}
              aria-label="打开 AI 设置"
              className="rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] hover:bg-[var(--bg-soft)]"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>

          <label className="grid gap-1.5 text-xs text-[var(--text-soft)]">
            自动采样间隔
            <select
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(Number(event.target.value))}
              disabled={visual.status === 'running'}
              className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2"
            >
              <option value={10}>10 秒</option>
              <option value={15}>15 秒</option>
              <option value={30}>30 秒</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-2">
            {visual.status === 'running' ? (
              <Button variant="secondary" onClick={() => session.pause()}>
                <CirclePause className="h-4 w-4" /> 暂停
              </Button>
            ) : (
              <Button onClick={startSession} disabled={!visionEnabled || cameraState !== 'on'}>
                <CirclePlay className="h-4 w-4" />
                {visual.status === 'paused' ? '继续' : '开始解释'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => session.stop()}
              disabled={visual.status === 'idle'}
            >
              停止
            </Button>
          </div>

          <div className="rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] px-3 py-2 text-xs text-[var(--text-soft)]">
            状态：{statusLabel(visual)} · {visual.steps}/{VISUAL_SESSION_MAX_STEPS} 步
          </div>

          {!visionEnabled && (
            <p className="rounded-[var(--radius-sm)] bg-[var(--accent-soft)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
              当前文本模型未明确支持图片输入。请在 AI 设置中选择受支持的视觉模型。
            </p>
          )}
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {observations.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--text-faint)]">
                解释结果仅保留在当前页面
              </p>
            ) : (
              observations.map((observation) => (
                <article
                  key={observation.step}
                  className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
                >
                  <div className="mb-1 text-xs font-medium text-[var(--accent-strong)]">
                    第 {observation.step} 步
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
  if (snapshot.requestInFlight) return '解释中';
  return {
    idle: '未开始',
    running: '等待采样',
    paused: '已暂停',
    complete: '已完成',
    error: '出错',
  }[snapshot.status];
}

export default App;
