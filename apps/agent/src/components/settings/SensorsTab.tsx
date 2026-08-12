import { SettingLabel, SettingToggle } from '@0xnullai/ui';
import type { Dispatch, SetStateAction } from 'react';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { ConfigNumberField } from './ConfigNumberField.js';
import type { DeviceLinkRule } from '@dg-agent/core';

const CIVET_THRESHOLD_MIN = 0.1;
const CIVET_THRESHOLD_MAX = 50;
const SENSOR_DEBOUNCE_MIN = 0;
const SENSOR_DEBOUNCE_MAX = 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Sensor triggers.
 *
 * Agent owns the live trigger state, while the unified settings panel places
 * these controls inside Device Safety beside the other device boundaries.
 */

export interface SensorsTabProps {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: Dispatch<SetStateAction<BrowserAppSettings>>;
  sensorTriggersEnabled: boolean;
  onToggleSensorTriggers: (enabled: boolean) => void;
  deviceLinkRule: DeviceLinkRule;
  onSetDeviceLinkRule: (rule: DeviceLinkRule) => void;
}

export function SensorsTab({
  settingsDraft,
  setSettingsDraft,
  sensorTriggersEnabled,
  onToggleSensorTriggers,
  deviceLinkRule,
  onSetDeviceLinkRule,
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
      <section className="settings-row-card grid gap-3">
        <h3 className="settings-card-legend">设备联动（Agent 本地）</h3>
        <SettingToggle
          label="允许传感器/按键直接控制负鼠"
          checked={deviceLinkRule.enabled}
          onCheckedChange={(enabled) => onSetDeviceLinkRule({ ...deviceLinkRule, enabled })}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={deviceLinkRule.source}
            onChange={(e) =>
              onSetDeviceLinkRule({
                ...deviceLinkRule,
                source: e.target.value as DeviceLinkRule['source'],
              })
            }
          >
            <option value="civet-pressure">灵猫压力</option>
            <option value="paw-button">爪印按键</option>
            <option value="opossum-button">负鼠按键</option>
          </select>
          <select
            value={deviceLinkRule.channel}
            onChange={(e) =>
              onSetDeviceLinkRule({
                ...deviceLinkRule,
                channel: e.target.value as DeviceLinkRule['channel'],
              })
            }
          >
            <option value="A">负鼠 A</option>
            <option value="B">负鼠 B</option>
            <option value="both">负鼠 A+B</option>
          </select>
          <select
            value={deviceLinkRule.pattern}
            onChange={(e) =>
              onSetDeviceLinkRule({
                ...deviceLinkRule,
                pattern: e.target.value as DeviceLinkRule['pattern'],
              })
            }
          >
            <option value="constant">恒定</option>
            <option value="pulse">脉冲</option>
            <option value="wave">波浪</option>
            <option value="ramp">渐强</option>
            <option value="heartbeat">心跳</option>
          </select>
          <label className="settings-inline-field text-xs">
            联动强度
            <ConfigNumberField
              id="device-link-intensity"
              value={deviceLinkRule.intensity}
              min={0}
              max={200}
              onChange={(intensity) => onSetDeviceLinkRule({ ...deviceLinkRule, intensity })}
            />
          </label>
        </div>
        <p className="settings-help-text">
          联动默认关闭；启用后仅在当前 Agent 进程内执行，不经过 AI 或房间转发。
        </p>
      </section>
    </div>
  );
}
