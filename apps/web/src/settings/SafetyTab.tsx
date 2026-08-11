import { useEffect, useState } from 'react';
import {
  DEFAULT_DEVICE_SAFETY,
  loadDeviceSafety,
  subscribeDeviceSafety,
  updateDeviceSafety,
  type DeviceSafetySettings,
} from '@0xnullai/settings';
import { ModuleSettingsSlot } from '@0xnullai/ui';

/**
 * Device safety. The only setting in the whole software that directly affects a
 * human body.
 *
 * **One copy shared by the whole app.** A cap set here is immediately the value in
 * Agent / Chat / Voice — before the merge the three modules each stored their own,
 * so a user would raise it in one place, switch to another, and find it back at the
 * old value, with nothing at all indicating that it had reverted.
 *
 * The layout deliberately avoids collapsible panels: these numbers decide how strong
 * the current is, so the user should see all of them at a glance instead of having
 * to expand something to find out what they set.
 */

interface NumberFieldSpec {
  key: keyof DeviceSafetySettings;
  label: string;
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
  },
  { key: 'maxStrengthB', label: 'B 通道上限', min: 0, max: 200 },
  {
    key: 'maxColdStartStrength',
    label: '冷启动上限',
    min: 0,
    max: 200,
  },
  { key: 'maxAdjustStep', label: '单次调节步长', min: 1, max: 200 },
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
  },
  { key: 'maxBurstStrengthRelative', label: '脉冲相对上限', min: 0, max: 200 },
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
    </label>
  );
}

function Group({
  title,
  fields,
  settings,
  onChange,
}: {
  title: string;
  fields: NumberFieldSpec[];
  settings: DeviceSafetySettings;
  onChange: (patch: Partial<DeviceSafetySettings>) => void;
}) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
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
      <Group title="郊狼" fields={COYOTE_FIELDS} settings={settings} onChange={patch} />

      <Group title="脉冲" fields={BURST_FIELDS} settings={settings} onChange={patch} />

      <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">脉冲需要通道已在输出</span>
          <input
            type="checkbox"
            checked={settings.burstRequiresActiveChannel}
            onChange={(e) => patch({ burstRequiresActiveChannel: e.target.checked })}
            className="accent-[var(--accent)]"
          />
        </label>
      </section>

      <Group title="负鼠" fields={OPOSSUM_FIELDS} settings={settings} onChange={patch} />

      <Group title="单回合上限" fields={TURN_FIELDS} settings={settings} onChange={patch} />

      <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
        <h3 className="text-sm font-semibold">权限与生命周期</h3>

        <label className="mt-3 grid grid-cols-[1fr_auto] items-center gap-4">
          <span className="text-sm">设备指令确认</span>
          <select
            value={settings.permissionMode}
            onChange={(e) =>
              patch({ permissionMode: e.target.value as DeviceSafetySettings['permissionMode'] })
            }
            className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-1.5 text-sm"
          >
            <option value="confirm">每次确认</option>
            <option value="timed">确认后 5 分钟免确认</option>
            <option value="allow-all">完全放行（不推荐）</option>
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

      <ModuleSettingsSlot id="agent-sensors" />
    </div>
  );
}
