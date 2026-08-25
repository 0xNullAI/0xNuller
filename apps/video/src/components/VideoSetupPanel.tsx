import { CirclePlay, Link, Settings } from 'lucide-react';
import { Button } from '@0xnullai/ui';
import type { VideoOutputKind } from '@dg-agent/agent-browser';
import type { CameraFacingMode } from '../hooks/use-camera-preview.js';

export type VideoTargetFamily = 'dg-lab' | 'embedded';

export interface VideoSetupOption {
  value: string;
  label: string;
}

export interface VideoSetupPanelViewModel {
  facingMode: CameraFacingMode;
  targetFamily: VideoTargetFamily;
  embeddedAvailable: boolean;
  showCoyoteConnect: boolean;
  coyoteConnectLabel: string;
  showOpossumConnect: boolean;
  targetOptions: readonly VideoSetupOption[];
  selectedTargetId: string;
  channel: 'A' | 'B';
  embeddedFeatureOptions: readonly VideoSetupOption[];
  selectedEmbeddedFeatureId: string;
  intensityLabel: string;
  intensityMax: number;
  intensityStep: number;
  intensityValue: number;
  durationMinutes: number;
  cadenceSeconds: number;
  allowEnhanced: boolean;
  allowBurst: boolean;
  visionEnabled: boolean;
  error: string | null;
  ctaLabel: string;
  ctaDisabled: boolean;
}

export interface VideoSetupPanelActions {
  openVideoSettings: () => void;
  setFacingMode: (value: CameraFacingMode) => void;
  setTargetFamily: (value: VideoTargetFamily) => void;
  connect: (kind: VideoOutputKind) => void;
  discoverEmbeddedDevices: () => void;
  selectTarget: (targetId: string) => void;
  selectEmbeddedFeature: (featureId: string) => void;
  setChannel: (channel: 'A' | 'B') => void;
  setIntensity: (value: number) => void;
  setDurationMinutes: (value: number) => void;
  setCadenceSeconds: (value: number) => void;
  setAllowEnhanced: (value: boolean) => void;
  setAllowBurst: (value: boolean) => void;
  activate: () => void;
}

interface VideoSetupPanelProps {
  view: VideoSetupPanelViewModel;
  actions: VideoSetupPanelActions;
}

const selectClassName =
  'rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2';

export function VideoSetupPanel({ view, actions }: VideoSetupPanelProps) {
  return (
    <section
      aria-labelledby="video-setup-title"
      className="mx-auto flex max-w-[680px] flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-5"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 id="video-setup-title" className="font-semibold">
            Video 设置
          </h1>
          <p className="mt-1 text-xs text-[var(--text-faint)]">确认后直接显示处理画面</p>
        </div>
        <button
          type="button"
          onClick={actions.openVideoSettings}
          aria-label="打开 AI 设置"
          className="rounded-[var(--radius-ctl)] p-2 text-[var(--text-faint)] hover:bg-[var(--bg-soft)]"
        >
          <Settings aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-[var(--text-soft)]">
          摄像头
          <select
            value={view.facingMode}
            onChange={(event) => actions.setFacingMode(event.target.value as CameraFacingMode)}
            className={selectClassName}
          >
            <option value="environment">后置</option>
            <option value="user">前置</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[var(--text-soft)]">
          输出
          <select
            value={view.targetFamily}
            onChange={(event) => actions.setTargetFamily(event.target.value as VideoTargetFamily)}
            className={selectClassName}
          >
            <option value="dg-lab">郊狼 / 负鼠</option>
            {view.embeddedAvailable && <option value="embedded">通用设备</option>}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {view.targetFamily === 'embedded' ? (
          <Button size="sm" variant="secondary" onClick={actions.discoverEmbeddedDevices}>
            <Link aria-hidden="true" className="h-3.5 w-3.5" /> 查找设备
          </Button>
        ) : (
          <>
            {view.showCoyoteConnect && (
              <Button size="sm" variant="secondary" onClick={() => actions.connect('coyote')}>
                <Link aria-hidden="true" className="h-3.5 w-3.5" />
                {view.coyoteConnectLabel}
              </Button>
            )}
            {view.showOpossumConnect && (
              <Button size="sm" variant="secondary" onClick={() => actions.connect('opossum')}>
                <Link aria-hidden="true" className="h-3.5 w-3.5" /> 连接负鼠
              </Button>
            )}
          </>
        )}
        <span className="text-xs text-[var(--text-faint)]">固定 16:9 · 自动处理</span>
      </div>

      {view.targetFamily === 'embedded' ? (
        <label className="grid gap-1 text-xs text-[var(--text-soft)]">
          振动功能
          <select
            value={view.selectedEmbeddedFeatureId}
            onChange={(event) => actions.selectEmbeddedFeature(event.target.value)}
            className={selectClassName}
          >
            <option value="">请选择</option>
            {view.embeddedFeatureOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <label className="grid gap-1 text-xs text-[var(--text-soft)]">
            目标
            <select
              value={view.selectedTargetId}
              onChange={(event) => actions.selectTarget(event.target.value)}
              className={selectClassName}
            >
              <option value="">请选择</option>
              {view.targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-[var(--text-soft)]">
            通道
            <select
              value={view.channel}
              onChange={(event) => actions.setChannel(event.target.value as 'A' | 'B')}
              className={selectClassName}
            >
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          </label>
        </div>
      )}

      <label className="grid gap-1 text-xs text-[var(--text-soft)]">
        强度上限 · {view.intensityLabel}
        <input
          type="range"
          min={0}
          max={view.intensityMax}
          step={view.intensityStep}
          value={view.intensityValue}
          onChange={(event) => actions.setIntensity(Number(event.target.value))}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-[var(--text-soft)]">
          时长
          <select
            value={view.durationMinutes}
            onChange={(event) => actions.setDurationMinutes(Number(event.target.value))}
            className={selectClassName}
          >
            {[1, 5, 10, 15].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} 分钟
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[var(--text-soft)]">
          观察间隔
          <select
            value={view.cadenceSeconds}
            onChange={(event) => actions.setCadenceSeconds(Number(event.target.value))}
            className={selectClassName}
          >
            {[5, 10, 15, 30].map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} 秒
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-[var(--text-soft)]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={view.allowEnhanced}
            onChange={(event) => actions.setAllowEnhanced(event.target.checked)}
          />
          允许增强
        </label>
        {view.targetFamily === 'dg-lab' && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={view.allowBurst}
              onChange={(event) => actions.setAllowBurst(event.target.checked)}
            />
            允许脉冲
          </label>
        )}
      </div>

      {!view.visionEnabled && (
        <button
          type="button"
          onClick={actions.openVideoSettings}
          className="text-left text-xs text-[var(--accent-strong)] underline underline-offset-2"
        >
          完成视觉模型设置后可启用 AI 控制
        </button>
      )}
      {view.error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {view.error}
        </p>
      )}

      <Button onClick={actions.activate} disabled={view.ctaDisabled}>
        <CirclePlay aria-hidden="true" className="h-4 w-4" />
        {view.ctaLabel}
      </Button>
    </section>
  );
}
