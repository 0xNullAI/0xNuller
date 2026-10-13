import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AudioWaveform, Radio, SlidersHorizontal, Waves, Zap } from 'lucide-react';
import {
  backgroundKeepHint,
  backgroundKeepOptions,
  DEFAULT_DEVICE_SAFETY,
  effectiveBackgroundKeepMinutes,
  isBackgroundKeepReady,
  isBackgroundKeepSupported,
  loadDeviceSafety,
  prepareBackgroundKeep,
  subscribeDeviceSafety,
  updateDeviceSafety,
  type DeviceSafetySettings,
} from '@0xnullai/settings';
import { ModuleSettingsSlot } from '@0xnullai/ui';
import { useDgLabRegistry } from '@0xnullai/native';
import { useDgLabDeviceLimits, type DgLabDeviceLimitEntry } from '@0xnullai/device-runtime';
import { AdvancedSubpage } from './SettingsAdvanced';
import { SelectRow, SettingsGroup, SettingsPage, SettingsRow, SliderRow } from './settings-list';

/**
 * 设备与安全. The only settings in the app that directly affect a human body.
 *
 * Two layers, both enforced by the device holder on every write: limits shared by every
 * device of a type, and each device's own limit. The effective limit is the lower one.
 * Settings users cannot change (per-turn AI caps) are product constants and never shown.
 */

const LIMIT_MAX = 200;
type Page = 'main' | 'advanced' | 'waveforms' | 'sensors' | { device: string };

export function SafetyTab({ waveforms }: { waveforms?: ReactNode }) {
  const [settings, setSettings] = useState<DeviceSafetySettings>(loadDeviceSafety);
  const [page, setPage] = useState<Page>('main');
  const [keepNotice, setKeepNotice] = useState<string | null>(null);
  const back = useCallback(() => setPage('main'), []);
  const registry = useDgLabRegistry();
  const devices = useDgLabDeviceLimits(registry);
  useEffect(() => subscribeDeviceSafety(setSettings), []);

  function patch(p: Partial<DeviceSafetySettings>) {
    setSettings(updateDeviceSafety((prev) => ({ ...prev, ...p })));
  }

  // A keep the platform cannot honour yet (Android: no notification permission) asks first;
  // a refusal stores "stop at once" so the setting never claims more than happens.
  async function chooseBackgroundKeep(minutes: number) {
    if (minutes > 0 && !isBackgroundKeepReady() && !(await prepareBackgroundKeep())) {
      setKeepNotice('未获得通知权限，切到后台时仍会立即停止。');
      patch({ backgroundKeepMinutes: 0 });
      return;
    }
    setKeepNotice(null);
    patch({ backgroundKeepMinutes: minutes });
  }

  if (page === 'waveforms')
    return (
      <AdvancedSubpage title="波形库" onBack={back}>
        {waveforms}
      </AdvancedSubpage>
    );

  if (page === 'sensors')
    return (
      <AdvancedSubpage title="传感器" onBack={back}>
        <ModuleSettingsSlot id="agent-sensors" />
      </AdvancedSubpage>
    );

  if (typeof page === 'object') {
    const device = devices.find((entry) => entry.stableKey === page.device);
    return (
      <AdvancedSubpage title={device?.name ?? '设备'} onBack={back}>
        {device ? (
          <DeviceLimitsPage
            device={device}
            onChange={(limits) => void registry.setOwnLimits(device.stableKey, limits)}
            onForget={() => {
              registry.forgetDeviceLimits(device.stableKey);
              back();
            }}
          />
        ) : (
          <p className="px-4 text-sm text-[var(--text-faint)]">这台设备已不在列表中。</p>
        )}
      </AdvancedSubpage>
    );
  }

  if (page === 'advanced')
    return (
      <AdvancedSubpage title="设备 · 高级" onBack={back}>
        <SettingsPage>
          <SettingsGroup
            label="郊狼"
            footer="从停止开始时，第一步最多到「启动上限」；之后每次最多加「单次调节步长」。"
          >
            <SliderRow
              label="启动上限"
              min={0}
              max={LIMIT_MAX}
              value={settings.maxColdStartStrength}
              onChange={(maxColdStartStrength) => patch({ maxColdStartStrength })}
            />
            <SliderRow
              label="单次调节步长"
              min={1}
              max={LIMIT_MAX}
              value={settings.maxAdjustStep}
              onChange={(maxAdjustStep) => patch({ maxAdjustStep })}
            />
          </SettingsGroup>
          <SettingsGroup
            label="脉冲"
            footer="脉冲是短促的加强。绝对上限、相对上限设为 0 表示不额外限制。"
          >
            <SliderRow
              label="最长时长"
              min={100}
              max={20_000}
              step={100}
              value={settings.maxBurstDurationMs}
              format={(ms) => `${(ms / 1000).toFixed(1)} 秒`}
              onChange={(maxBurstDurationMs) => patch({ maxBurstDurationMs })}
            />
            <SliderRow
              label="绝对上限"
              min={0}
              max={LIMIT_MAX}
              value={settings.maxBurstStrengthAbsolute}
              onChange={(maxBurstStrengthAbsolute) => patch({ maxBurstStrengthAbsolute })}
            />
            <SliderRow
              label="相对上限"
              min={0}
              max={LIMIT_MAX}
              value={settings.maxBurstStrengthRelative}
              format={(value) => (value ? `+${value}` : '0')}
              onChange={(maxBurstStrengthRelative) => patch({ maxBurstStrengthRelative })}
            />
          </SettingsGroup>
          <SettingsGroup label="负鼠">
            <SliderRow
              label="启动上限"
              min={0}
              max={LIMIT_MAX}
              value={settings.maxColdStartIntensity}
              onChange={(maxColdStartIntensity) => patch({ maxColdStartIntensity })}
            />
            <SliderRow
              label="单次调节步长"
              min={1}
              max={LIMIT_MAX}
              value={settings.maxOpossumAdjustStep}
              onChange={(maxOpossumAdjustStep) => patch({ maxOpossumAdjustStep })}
            />
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow icon={Radio} label="传感器" onClick={() => setPage('sensors')} />
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow
              label="恢复默认值"
              tone="danger"
              chevron={false}
              onClick={() => {
                if (!window.confirm('把全部设备安全设置恢复为默认值？')) return;
                setSettings(updateDeviceSafety(() => ({ ...DEFAULT_DEVICE_SAFETY })));
              }}
            />
          </SettingsGroup>
        </SettingsPage>
      </AdvancedSubpage>
    );

  return (
    <SettingsPage>
      <SettingsGroup
        label="所有设备共用的上限"
        footer="每台设备都不会超过这里的值；设备自己的上限更低时，以更低的为准。"
      >
        <SliderRow
          label="郊狼 A 通道"
          min={0}
          max={LIMIT_MAX}
          value={settings.maxStrengthA}
          onChange={(maxStrengthA) => patch({ maxStrengthA })}
        />
        <SliderRow
          label="郊狼 B 通道"
          min={0}
          max={LIMIT_MAX}
          value={settings.maxStrengthB}
          onChange={(maxStrengthB) => patch({ maxStrengthB })}
        />
        <SliderRow
          label="负鼠 A 通道"
          min={0}
          max={LIMIT_MAX}
          value={settings.maxIntensityA}
          onChange={(maxIntensityA) => patch({ maxIntensityA })}
        />
        <SliderRow
          label="负鼠 B 通道"
          min={0}
          max={LIMIT_MAX}
          value={settings.maxIntensityB}
          onChange={(maxIntensityB) => patch({ maxIntensityB })}
        />
      </SettingsGroup>

      <SettingsGroup
        label="我的设备"
        footer="点开一台设备可单独设置它的上限。急停会同时停止所有已连接设备。"
      >
        {devices.length === 0 ? (
          <SettingsRow label="还没有连接过设备" detail="在「设备」页连接后会出现在这里" />
        ) : (
          devices.map((device) => (
            <SettingsRow
              key={device.stableKey}
              icon={device.kind === 'coyote' ? Zap : Waves}
              label={device.name}
              detail={deviceStatus(device)}
              value={`A ${device.effectiveLimits.a} · B ${device.effectiveLimits.b}`}
              onClick={() => setPage({ device: device.stableKey })}
            />
          ))
        )}
      </SettingsGroup>

      <SettingsGroup
        label="控制"
        footer={
          isBackgroundKeepSupported()
            ? [
                '后台保持期间，设备维持当时的输出，只能停止或降低；AI 暂停，到时自动停止。关闭或刷新页面、语音通话和视频始终立即停止。',
                backgroundKeepHint(),
                keepNotice,
              ]
                .filter(Boolean)
                .join('')
            : '切到后台时立即停止所有设备。'
        }
      >
        {isBackgroundKeepSupported() ? (
          <SelectRow
            label="切到后台时"
            value={String(effectiveBackgroundKeepMinutes())}
            onChange={(value) => void chooseBackgroundKeep(Number(value))}
            options={backgroundKeepOptions().map((minutes) => ({
              value: String(minutes),
              label: minutes === 0 ? '立即停止（推荐）' : `保持当前输出 ${minutes} 分钟`,
            }))}
          />
        ) : null}
        <SelectRow
          label="设备指令确认"
          value={settings.permissionMode}
          onChange={(value) =>
            patch({ permissionMode: value as DeviceSafetySettings['permissionMode'] })
          }
          options={[
            { value: 'confirm', label: '每次确认' },
            { value: 'timed', label: '确认后 5 分钟免确认' },
            { value: 'allow-all', label: '完全放行（不推荐）' },
          ]}
        />
        {waveforms ? (
          <SettingsRow icon={AudioWaveform} label="波形库" onClick={() => setPage('waveforms')} />
        ) : null}
        <SettingsRow icon={SlidersHorizontal} label="高级" onClick={() => setPage('advanced')} />
      </SettingsGroup>
    </SettingsPage>
  );
}

function deviceStatus(device: DgLabDeviceLimitEntry): string {
  const kind = device.kind === 'coyote' ? '郊狼' : '负鼠';
  if (!device.connected) return `${kind} · 未连接`;
  return device.battery === null ? `${kind} · 已连接` : `${kind} · 电量 ${device.battery}%`;
}

function DeviceLimitsPage({
  device,
  onChange,
  onForget,
}: {
  device: DgLabDeviceLimitEntry;
  onChange: (limits: { a?: number; b?: number }) => void;
  onForget: () => void;
}) {
  const kind = device.kind === 'coyote' ? '郊狼' : '负鼠';
  return (
    <SettingsPage>
      <SettingsGroup
        label="这台设备的上限"
        footer={`实际生效：A ${device.effectiveLimits.a} · B ${device.effectiveLimits.b}（不超过所有${kind}共用的 A ${device.globalLimits.a} · B ${device.globalLimits.b}）。设为 ${LIMIT_MAX} 表示不额外限制。`}
      >
        <SliderRow
          label="A 通道"
          min={0}
          max={LIMIT_MAX}
          value={device.ownLimits.a}
          onChange={(a) => onChange({ a })}
        />
        <SliderRow
          label="B 通道"
          min={0}
          max={LIMIT_MAX}
          value={device.ownLimits.b}
          onChange={(b) => onChange({ b })}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label={kind} detail={deviceStatus(device)} />
      </SettingsGroup>
      {!device.connected && (
        <SettingsGroup>
          <SettingsRow label="忘记这台设备" tone="danger" chevron={false} onClick={onForget} />
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
