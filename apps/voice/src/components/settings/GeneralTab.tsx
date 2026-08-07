import { Input } from '@/components/ui/input';
import { HelpTip } from '@/components/HelpTip';
import { SettingLabel } from './SettingLabel';
import { SettingSelect } from './SettingSelect';
import {
  getRealtimeProviderDefinition,
  REALTIME_PROVIDER_DEFINITIONS,
  type RealtimeProviderId,
} from '@/lib/realtime/providers';
import type { ThemeMode, VoiceSettings } from '@/lib/settings';
import type { BrowserPermissionMode } from '@/lib/permissions';

interface GeneralTabProps {
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'auto', label: '系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

const PERMISSION_MODE_OPTIONS: Array<{ value: BrowserPermissionMode; label: string }> = [
  { value: 'confirm', label: '每次确认（默认，最严格）' },
  { value: 'timed', label: '首次确认后 5 分钟内免确认' },
  { value: 'allow-all', label: '完全放行（不推荐）' },
];

export function GeneralTab({ settings, updateSettings }: GeneralTabProps) {
  const provider = getRealtimeProviderDefinition(settings.activeProviderId);
  const providerSettings = settings.providers[settings.activeProviderId];

  const setProviderField = (key: 'apiKey' | 'model' | 'baseUrl' | 'deployment', value: string) => {
    updateSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], [key]: value },
      },
    }));
  };

  return (
    <div className="settings-panel-tab-content">
      {/* ---- 基本设置 ---- */}
      <div className="settings-row-card grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3">
        <h3 className="settings-card-legend">基本设置</h3>

        <SettingLabel>主题模式</SettingLabel>
        <div className="settings-inline-field-control flex rounded-full bg-[var(--bg-strong)] p-0.5 text-xs">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`flex-1 rounded-full px-3.5 py-1 text-xs font-medium transition-all duration-150 ${
                settings.theme === option.value
                  ? 'bg-[var(--accent)] text-[var(--button-text)]'
                  : 'text-[var(--text-soft)] hover:text-[var(--text)]'
              }`}
              onClick={() => updateSettings((prev) => ({ ...prev, theme: option.value }))}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- 语音供应商 ---- */}
      <div className="settings-row-card">
        <h3 className="settings-card-legend">语音供应商</h3>

        <label className="settings-inline-field">
          <SettingLabel className="flex items-center gap-1.5">
            Provider
            <HelpTip text="xAI/OpenAI/Azure 走同一套客户端；智谱 GLM 免服务端中转，本地签名直连。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <SettingSelect
              value={settings.activeProviderId}
              onValueChange={(value) =>
                updateSettings((prev) => ({ ...prev, activeProviderId: value as RealtimeProviderId }))
              }
              options={REALTIME_PROVIDER_DEFINITIONS.map((def) => ({
                value: def.id,
                label: def.pricePerMinuteUsd ? `${def.name} · $${def.pricePerMinuteUsd}/分钟` : def.name,
              }))}
            />
          </div>
        </label>

        {provider?.hint && <p className="text-xs text-[var(--text-faint)]">{provider.hint}</p>}

        {provider?.fields.map((field) => (
          <label key={field.key} className="settings-inline-field">
            <SettingLabel>{field.label}</SettingLabel>
            <div className="settings-inline-field-control">
              <Input
                type={field.type === 'password' ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={providerSettings[field.key]}
                onChange={(e) => setProviderField(field.key, e.target.value)}
              />
            </div>
          </label>
        ))}
      </div>

      {/* ---- 确认模式 ---- */}
      <div className="settings-row-card">
        <h3 className="settings-card-legend">工具调用确认</h3>
        <label className="settings-inline-field">
          <SettingLabel className="flex items-center gap-1.5">
            确认模式
            <HelpTip text="这里选什么，通话中就是什么行为。「每次确认」会在每个改变设备状态的工具调用前弹窗确认；「5 分钟内免确认」第一次仍会弹窗，同意后 5 分钟内不再打断。无论哪一档，强度上限、冷启动钳制这些硬性限制都始终生效、模型绕不过。" />
          </SettingLabel>
          <div className="settings-inline-field-control">
            <SettingSelect
              value={settings.permissionMode}
              onValueChange={(value) =>
                updateSettings((prev) => ({ ...prev, permissionMode: value as BrowserPermissionMode }))
              }
              options={PERMISSION_MODE_OPTIONS}
            />
          </div>
        </label>
      </div>
    </div>
  );
}
