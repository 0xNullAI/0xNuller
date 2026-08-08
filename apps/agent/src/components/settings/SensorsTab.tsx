import { SettingLabel, SettingToggle } from '@0xnullai/ui';
import type { Dispatch, SetStateAction } from 'react';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { ConfigNumberField } from './SafetyTab.js';

const CIVET_THRESHOLD_MIN = 0.1;
const CIVET_THRESHOLD_MAX = 50;
const SENSOR_DEBOUNCE_MIN = 0;
const SENSOR_DEBOUNCE_MAX = 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 传感器触发。
 *
 * 从原来的「安全」标签页里拆出来的——安全设置已经搬到统一设置面板，而这一项是
 * Agent 独有的功能（爪印/灵猫的读数驱动 AI 主动响应），不是跨模块的安全约束，
 * 所以留在 Agent 自己这边。
 */

export interface SensorsTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  sensorTriggersEnabled: boolean;
  onToggleSensorTriggers: (enabled: boolean) => void;
}

export function SensorsTab({
  settingsDraft,
  setSettingsDraft,
  sensorTriggersEnabled,
  onToggleSensorTriggers,
}: SensorsTabProps) {
  const setCivetPressureDeltaThresholdKPa = (value: number) =>
    setSettingsDraft((current) => ({
      ...current,
      civetPressureDeltaThresholdKPa: clamp(value, CIVET_THRESHOLD_MIN, CIVET_THRESHOLD_MAX),
    }));
  const setSensorTriggerDebounceMs = (value: number) =>
    setSettingsDraft((current) => ({
      ...current,
      sensorTriggerDebounceMs: clamp(value, SENSOR_DEBOUNCE_MIN, SENSOR_DEBOUNCE_MAX),
    }));

  return (
    <div className="settings-panel-tab-content">
      <section className="settings-row-card grid gap-3">
        <h3 className="settings-card-legend">传感器触发</h3>
        <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
          开启后，爪印按键触发或灵猫压力明显变化会作为内部提醒推送给
          AI，由它自行判断是否响应；不会自动改变设备状态。默认关闭。
        </p>
        <SettingToggle
          label="允许传感器事件驱动 AI 主动响应"
          checked={sensorTriggersEnabled}
          onCheckedChange={onToggleSensorTriggers}
        />

        <label htmlFor="civet-pressure-delta-threshold" className="settings-inline-field">
          <SettingLabel>灵猫压力变化触发阈值（kPa）</SettingLabel>
          <ConfigNumberField
            id="civet-pressure-delta-threshold"
            value={settingsDraft.civetPressureDeltaThresholdKPa}
            min={CIVET_THRESHOLD_MIN}
            max={CIVET_THRESHOLD_MAX}
            onChange={setCivetPressureDeltaThresholdKPa}
            allowDecimal
          />
        </label>

        <label htmlFor="sensor-trigger-debounce" className="settings-inline-field">
          <SettingLabel>传感器触发去抖间隔（ms）</SettingLabel>
          <ConfigNumberField
            id="sensor-trigger-debounce"
            value={settingsDraft.sensorTriggerDebounceMs}
            min={SENSOR_DEBOUNCE_MIN}
            max={SENSOR_DEBOUNCE_MAX}
            onChange={setSensorTriggerDebounceMs}
          />
        </label>
      </section>
    </div>
  );
}
