import { Input } from '@0xnullai/ui';
import { SettingLabel } from './SettingLabel';
import { SettingSelect } from './SettingSelect';
import { useProviderVoices } from '@/hooks/use-provider-voices';
import { getRealtimeProviderDefinition, type RealtimeProviderId } from '@/lib/realtime/providers';
import type { VoiceSettings } from '@/lib/settings';

interface VoiceTabProps {
  settings: VoiceSettings;
  updateSettings: (updater: (prev: VoiceSettings) => VoiceSettings) => void;
}

export function VoiceTab({ settings, updateSettings }: VoiceTabProps) {
  const provider = getRealtimeProviderDefinition(settings.activeProviderId);
  const providerSettings = settings.providers[settings.activeProviderId];

  const setVoice = (value: string) =>
    updateSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], voice: value },
      },
    }));

  const setSpeed = (value: number) =>
    updateSettings((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], speed: value },
      },
    }));

  return (
    <div className="settings-panel-tab-content">
      <div className="settings-row-card">
        <h3 className="settings-card-legend">音色与语速</h3>

        <VoiceField
          providerId={settings.activeProviderId}
          apiKey={providerSettings.apiKey}
          staticVoices={provider?.staticVoices ?? []}
          value={providerSettings.voice}
          onChange={setVoice}
        />

        <label className="settings-inline-field">
          <SettingLabel>语速（0.7 - 1.5）</SettingLabel>
          <div className="settings-inline-field-control">
            <Input
              type="number"
              min={0.7}
              max={1.5}
              step={0.1}
              value={providerSettings.speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </div>
        </label>
      </div>
    </div>
  );
}

function VoiceField({
  providerId,
  apiKey,
  staticVoices,
  value,
  onChange,
}: {
  providerId: RealtimeProviderId;
  apiKey: string;
  staticVoices: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { voices, loading, error } = useProviderVoices(providerId, apiKey, staticVoices);
  // Keep the currently-selected voice selectable even if it's not in the
  // freshly-fetched list (e.g. a custom voice id) rather than silently
  // dropping to a different voice.
  const options = value && !voices.includes(value) ? [value, ...voices] : voices;

  return (
    <label className="settings-inline-field">
      <SettingLabel className="flex items-center gap-1.5">
        音色
        {loading && <span className="text-xs font-normal text-[var(--text-faint)]">加载中…</span>}
      </SettingLabel>
      <div className="settings-inline-field-control space-y-1.5">
        <SettingSelect
          value={value}
          onValueChange={onChange}
          options={options.map((voice) => ({ value: voice, label: voice }))}
        />
        {error && (
          <p className="text-xs text-[var(--danger)]">音色列表获取失败，已回退到内置列表：{error}</p>
        )}
      </div>
    </label>
  );
}
