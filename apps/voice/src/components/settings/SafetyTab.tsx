import { Input } from '@0xnullai/ui';
import { SettingLabel } from './SettingLabel';
import { SettingToggle } from './SettingToggle';
import type { VoiceSettings } from '@/lib/settings';

interface SafetyTabProps {
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
}

export function SafetyTab({ settings, updateSettings }: SafetyTabProps) {
  return (
    <div className="settings-panel-tab-content">
      <div className="settings-row-card">
        <h3 className="settings-card-legend">郊狼安全上限</h3>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="A 通道强度上限"
            value={settings.coyoteSafety.maxStrengthA}
            onChange={(v) =>
              updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxStrengthA: v } }))
            }
          />
          <NumberField
            label="B 通道强度上限"
            value={settings.coyoteSafety.maxStrengthB}
            onChange={(v) =>
              updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxStrengthB: v } }))
            }
          />
          <NumberField
            label="冷启动上限"
            value={settings.coyoteSafety.maxColdStartStrength}
            onChange={(v) =>
              updateSettings((prev) => ({
                ...prev,
                coyoteSafety: { ...prev.coyoteSafety, maxColdStartStrength: v },
              }))
            }
          />
          <NumberField
            label="单次调节幅度"
            value={settings.coyoteSafety.maxAdjustStep}
            onChange={(v) =>
              updateSettings((prev) => ({ ...prev, coyoteSafety: { ...prev.coyoteSafety, maxAdjustStep: v } }))
            }
          />
        </div>
      </div>

      <div className="settings-row-card">
        <h3 className="settings-card-legend">负鼠安全上限</h3>
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="A 通道强度上限"
            value={settings.opossumSafety.maxIntensityA}
            onChange={(v) =>
              updateSettings((prev) => ({ ...prev, opossumSafety: { ...prev.opossumSafety, maxIntensityA: v } }))
            }
          />
          <NumberField
            label="B 通道强度上限"
            value={settings.opossumSafety.maxIntensityB}
            onChange={(v) =>
              updateSettings((prev) => ({ ...prev, opossumSafety: { ...prev.opossumSafety, maxIntensityB: v } }))
            }
          />
        </div>
      </div>

      <div className="settings-row-card">
        <h3 className="settings-card-legend">对话行为</h3>
        <SettingToggle
          label="允许 AI 主动开口"
          description="开启后，传感器事件可以触发 AI 立即回应，而不必等下一个自然轮次。关闭时更克制。"
          checked={settings.allowProactiveSpeech}
          onCheckedChange={(checked) =>
            updateSettings((prev) => ({ ...prev, allowProactiveSpeech: checked }))
          }
        />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5">
      <SettingLabel className="text-[var(--text-soft)]">{label}</SettingLabel>
      <Input type="number" min={0} max={200} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
