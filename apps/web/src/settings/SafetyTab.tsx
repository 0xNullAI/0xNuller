import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_DEVICE_SAFETY,
  loadDeviceSafety,
  subscribeDeviceSafety,
  updateDeviceSafety,
  type DeviceSafetySettings,
} from '@0xnullai/settings';
import { ModuleSettingsSlot } from '@0xnullai/ui';
import { AdvancedEntryRow, AdvancedSubpage } from './SettingsAdvanced';

/**
 * Device safety. The only setting in the whole software that directly affects a
 * human body.
 *
 * **One copy shared by the whole app.** A cap set here is immediately the value in
 * Agent / Chat / Voice — before the merge the three modules each stored their own,
 * so a user would raise it in one place, switch to another, and find it back at the
 * old value, with nothing at all indicating that it had reverted.
 *
 * The page shows only the channel caps and command confirmation. Cold start, step,
 * burst and sensor settings sit on one flat 高级 sub-page. Per-turn tool caps are fixed
 * constants in `@0xnullai/settings`, so they have no control here.
 */

interface NumberFieldSpec {
  key: keyof DeviceSafetySettings;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

const COYOTE_LIMIT_FIELDS: NumberFieldSpec[] = [
  { key: 'maxStrengthA', label: 'A 通道上限', min: 0, max: 200 },
  { key: 'maxStrengthB', label: 'B 通道上限', min: 0, max: 200 },
];

const COYOTE_ADVANCED_FIELDS: NumberFieldSpec[] = [
  { key: 'maxColdStartStrength', label: '冷启动上限', min: 0, max: 200 },
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
  { key: 'maxBurstStrengthAbsolute', label: '脉冲绝对上限', min: 0, max: 200 },
  { key: 'maxBurstStrengthRelative', label: '脉冲相对上限', min: 0, max: 200 },
];

const OPOSSUM_LIMIT_FIELDS: NumberFieldSpec[] = [
  { key: 'maxIntensityA', label: 'A 通道上限', min: 0, max: 200 },
  { key: 'maxIntensityB', label: 'B 通道上限', min: 0, max: 200 },
];

const OPOSSUM_ADVANCED_FIELDS: NumberFieldSpec[] = [
  { key: 'maxColdStartIntensity', label: '冷启动上限', min: 0, max: 200 },
  { key: 'maxOpossumAdjustStep', label: '单次调节步长', min: 1, max: 200 },
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

/** One plain group: a heading and its rows. No collapsing. */
function Group({
  title,
  fields,
  settings,
  onChange,
  children,
}: {
  title: string;
  fields: NumberFieldSpec[];
  settings: DeviceSafetySettings;
  onChange: (patch: Partial<DeviceSafetySettings>) => void;
  children?: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-1 divide-y divide-[var(--surface-border)]">
        {fields.map((f) => (
          <NumberField
            key={f.key}
            spec={f}
            value={settings[f.key] as number}
            onChange={(v) => onChange({ [f.key]: v } as Partial<DeviceSafetySettings>)}
          />
        ))}
        {children}
      </div>
    </section>
  );
}

export function SafetyTab() {
  const [settings, setSettings] = useState<DeviceSafetySettings>(loadDeviceSafety);
  const [advanced, setAdvanced] = useState(false);
  const closeAdvanced = useCallback(() => setAdvanced(false), []);
  useEffect(() => subscribeDeviceSafety(setSettings), []);

  function patch(p: Partial<DeviceSafetySettings>) {
    setSettings(updateDeviceSafety((prev) => ({ ...prev, ...p })));
  }

  if (advanced)
    return (
      <AdvancedSubpage title="设备安全 · 高级" onBack={closeAdvanced}>
        <Group title="郊狼" fields={COYOTE_ADVANCED_FIELDS} settings={settings} onChange={patch} />
        <Group title="脉冲" fields={BURST_FIELDS} settings={settings} onChange={patch}>
          <label className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm">脉冲需要通道已在输出</span>
            <input
              type="checkbox"
              checked={settings.burstRequiresActiveChannel}
              onChange={(e) => patch({ burstRequiresActiveChannel: e.target.checked })}
              className="accent-[var(--accent)]"
            />
          </label>
        </Group>
        <Group title="负鼠" fields={OPOSSUM_ADVANCED_FIELDS} settings={settings} onChange={patch} />
        <ModuleSettingsSlot id="agent-sensors" />
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
      </AdvancedSubpage>
    );

  return (
    <div className="flex flex-col gap-6">
      <Group title="郊狼" fields={COYOTE_LIMIT_FIELDS} settings={settings} onChange={patch} />
      <Group title="负鼠" fields={OPOSSUM_LIMIT_FIELDS} settings={settings} onChange={patch} />
      <label className="grid grid-cols-[1fr_auto] items-center gap-4">
        <span className="text-sm font-semibold">设备指令确认</span>
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
      <AdvancedEntryRow onOpen={() => setAdvanced(true)} />
    </div>
  );
}
