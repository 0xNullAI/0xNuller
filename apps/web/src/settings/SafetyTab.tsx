import { useEffect, useState } from 'react';
import {
  DEFAULT_DEVICE_SAFETY,
  loadDeviceSafety,
  subscribeDeviceSafety,
  updateDeviceSafety,
  type DeviceSafetySettings,
} from '@0xnullai/settings';

/**
 * 设备安全。整个软件里唯一直接影响人体的设置。
 *
 * **全应用共享一份。** 在这里调的上限，Agent / Chat / Voice 立刻都是这个值——合并前
 * 三个模块各存各的，用户在一处调高，切到另一处又变回去，而变回去这件事没有任何提示。
 *
 * 排版上刻意不做成折叠面板：这些数字决定电流有多大，用户应该一眼看到全部，而不是
 * 需要展开才知道自己设了什么。
 */

interface NumberFieldSpec {
  key: keyof DeviceSafetySettings;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

const COYOTE_FIELDS: NumberFieldSpec[] = [
  {
    key: 'maxStrengthA',
    label: 'A 通道上限',
    min: 0,
    max: 200,
    hint: '任何来源都不能让 A 通道超过这个值',
  },
  { key: 'maxStrengthB', label: 'B 通道上限', min: 0, max: 200 },
  {
    key: 'maxColdStartStrength',
    label: '冷启动上限',
    min: 0,
    max: 200,
    hint: '从零开始时单次能拉到的最高值，防止一上来就是满档',
  },
  { key: 'maxAdjustStep', label: '单次调节步长', min: 1, max: 200, hint: '一次指令最多能加减多少' },
];

const BURST_FIELDS: NumberFieldSpec[] = [
  {
    key: 'maxBurstDurationMs',
    label: '脉冲最长时长',
    min: 100,
    max: 20_000,
    step: 100,
    unit: 'ms',
  },
  {
    key: 'maxBurstStrengthAbsolute',
    label: '脉冲绝对上限',
    min: 0,
    max: 200,
    hint: '0 = 不启用这条额外约束',
  },
  { key: 'maxBurstStrengthRelative', label: '脉冲相对上限', min: 0, max: 200, hint: '0 = 不启用' },
];

const OPOSSUM_FIELDS: NumberFieldSpec[] = [
  { key: 'maxIntensityA', label: 'A 通道上限', min: 0, max: 200 },
  { key: 'maxIntensityB', label: 'B 通道上限', min: 0, max: 200 },
  { key: 'maxColdStartIntensity', label: '冷启动上限', min: 0, max: 200 },
  { key: 'maxOpossumAdjustStep', label: '单次调节步长', min: 1, max: 200 },
];

const TURN_FIELDS: NumberFieldSpec[] = [
  { key: 'maxToolIterations', label: '单回合工具轮数', min: 1, max: 32 },
  { key: 'maxToolCallsPerTurn', label: '单回合工具调用总数', min: 1, max: 64 },
  { key: 'maxAdjustStrengthCallsPerTurn', label: '单回合调节次数', min: 1, max: 32 },
  { key: 'maxBurstCallsPerTurn', label: '单回合脉冲次数', min: 0, max: 32 },
];

function NumberField({
  spec,
  value,
  onChange,
}: {
  spec: NumberFieldSpec;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-2">
      <span className="text-sm">{spec.label}</span>
      <span className="flex items-center gap-2">
        <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-[140px] accent-[var(--accent)] sm:w-[200px]"
        />
        <span className="w-[64px] shrink-0 text-right font-mono text-sm tabular-nums">
          {value}
          {spec.unit ?? ''}
        </span>
      </span>
      {spec.hint && (
        <span className="col-span-2 text-xs leading-relaxed text-[var(--text-faint)]">
          {spec.hint}
        </span>
      )}
    </label>
  );
}

function Group({
  title,
  desc,
  fields,
  settings,
  onChange,
}: {
  title: string;
  desc?: string;
  fields: NumberFieldSpec[];
  settings: DeviceSafetySettings;
  onChange: (patch: Partial<DeviceSafetySettings>) => void;
}) {
  return (
    <section className="rounded-[14px] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {desc && <p className="mt-1 text-xs text-[var(--text-faint)]">{desc}</p>}
      <div className="mt-2 divide-y divide-[var(--surface-border)]">
        {fields.map((f) => (
          <NumberField
            key={f.key}
            spec={f}
            value={settings[f.key] as number}
            onChange={(v) => onChange({ [f.key]: v } as Partial<DeviceSafetySettings>)}
          />
        ))}
      </div>
    </section>
  );
}

export function SafetyTab() {
  const [settings, setSettings] = useState<DeviceSafetySettings>(loadDeviceSafety);

  useEffect(() => subscribeDeviceSafety(setSettings), []);

  function patch(p: Partial<DeviceSafetySettings>) {
    setSettings(updateDeviceSafety((prev) => ({ ...prev, ...p })));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-[10px] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-soft)]">
        这些上限在<strong className="font-semibold text-[var(--text)]">设备持有者一侧</strong>
        执行。来自房间里其他人、AI 或游戏逻辑的数值都会被钳制到这里设定的范围内—— 它们说了不算。
      </p>

      <Group
        title="郊狼"
        desc="全应用共享。在这里调的值，Agent、Chat、Voice 立刻都是这个值。"
        fields={COYOTE_FIELDS}
        settings={settings}
        onChange={patch}
      />

      <Group title="脉冲" fields={BURST_FIELDS} settings={settings} onChange={patch} />

      <section className="rounded-[14px] border border-[var(--surface-border)] p-4">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm">脉冲需要通道已在输出</span>
            <span className="block text-xs text-[var(--text-faint)]">
              关闭后允许从静止状态直接脉冲
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.burstRequiresActiveChannel}
            onChange={(e) => patch({ burstRequiresActiveChannel: e.target.checked })}
            className="accent-[var(--accent)]"
          />
        </label>
      </section>

      <Group title="负鼠" fields={OPOSSUM_FIELDS} settings={settings} onChange={patch} />

      <Group
        title="单回合上限"
        desc="限制 AI 在一次回复里能连续下多少条指令。"
        fields={TURN_FIELDS}
        settings={settings}
        onChange={patch}
      />

      <section className="rounded-[14px] border border-[var(--surface-border)] p-4">
        <h3 className="text-sm font-semibold">权限与生命周期</h3>

        <label className="mt-3 grid grid-cols-[1fr_auto] items-center gap-4">
          <span>
            <span className="block text-sm">设备指令确认</span>
            <span className="block text-xs text-[var(--text-faint)]">
              「完全放行」只在本次会话有效，不会被记住
            </span>
          </span>
          <select
            value={settings.permissionMode}
            onChange={(e) =>
              patch({ permissionMode: e.target.value as DeviceSafetySettings['permissionMode'] })
            }
            className="rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-1.5 text-sm"
          >
            <option value="confirm">每次确认</option>
            <option value="timed">确认后 5 分钟免确认</option>
            <option value="allow-all">完全放行（不推荐）</option>
          </select>
        </label>

        <label className="mt-3 grid grid-cols-[1fr_auto] items-center gap-4">
          <span>
            <span className="block text-sm">切到后台时</span>
            <span className="block text-xs text-[var(--text-faint)]">
              移动端始终停止，不受此项影响
            </span>
          </span>
          <select
            value={settings.backgroundBehavior}
            onChange={(e) =>
              patch({
                backgroundBehavior: e.target.value as DeviceSafetySettings['backgroundBehavior'],
              })
            }
            className="rounded-[10px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-1.5 text-sm"
          >
            <option value="stop">停止输出</option>
            <option value="keep">保持输出</option>
          </select>
        </label>
      </section>

      <button
        type="button"
        onClick={() => {
          if (!window.confirm('把全部设备安全设置恢复为默认值？')) return;
          setSettings(updateDeviceSafety(() => ({ ...DEFAULT_DEVICE_SAFETY })));
        }}
        className="self-start text-xs text-[var(--text-soft)] underline underline-offset-2 hover:text-[var(--text)]"
      >
        恢复默认值
      </button>
    </div>
  );
}
