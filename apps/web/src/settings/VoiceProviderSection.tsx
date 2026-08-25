import { useState } from 'react';
import { Input, SettingSelect } from '@0xnullai/ui';
import {
  REALTIME_PROVIDER_DEFINITIONS,
  getRealtimeProviderDefinition,
  type RealtimeProviderId,
} from '../../../voice/src/lib/realtime/providers';
import { useProviderVoices } from '../../../voice/src/hooks/use-provider-voices';
import { loadSettings, saveSettings, type VoiceSettings } from '../../../voice/src/lib/settings';
import { ProviderFieldControls } from './ProviderFieldControls';

/**
 * Voice (realtime) provider.
 *
 * A sibling of the text LLM rather than mixed into the same group of fields:
 * realtime is a different protocol, with different endpoints, auth and tunable
 * parameters (voice and speed simply do not exist on the text side). Forcing them
 * into one group makes the two sides' required fields pollute each other — the user
 * would see a pile of inputs that mean nothing for the current provider.
 *
 * It reads and writes Voice's settings module directly instead of copying its shape:
 * a copy is another source of truth, and eliminating that kind of thing is the whole
 * point of the merge.
 */
export function VoiceProviderSection() {
  // Reading once per mount is enough — the settings panel is a dialog, so the component
  // is only created when it opens, which makes the initial value inherently current.
  // No effect to read it again: that would be a synchronous setState inside an effect,
  // costing one extra render + commit.
  const [settings, setSettings] = useState<VoiceSettings>(loadSettings);

  function update(updater: (prev: VoiceSettings) => VoiceSettings) {
    const next = updater(settings);
    setSettings(next);
    saveSettings(next);
  }

  const def = getRealtimeProviderDefinition(settings.activeProviderId);
  const current = settings.providers[settings.activeProviderId];

  function setField(
    key: 'apiKey' | 'model' | 'baseUrl' | 'deployment' | 'voice' | 'speed',
    value: string | number,
  ) {
    update((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [prev.activeProviderId]: { ...prev.providers[prev.activeProviderId], [key]: value },
      },
    }));
  }

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--surface-border)] p-4">
      <h3 className="text-sm font-semibold">语音模型</h3>

      <div className="mt-3 flex flex-col gap-3">
        <SettingSelect
          value={settings.activeProviderId}
          onValueChange={(value) =>
            update((prev) => ({
              ...prev,
              activeProviderId: value as VoiceSettings['activeProviderId'],
            }))
          }
          options={REALTIME_PROVIDER_DEFINITIONS.map((p) => ({ value: p.id, label: p.name }))}
        />

        <ProviderFieldControls
          fields={def?.fields ?? []}
          getValue={(key) => (current?.[key as keyof typeof current] as string) ?? ''}
          onValueChange={(key, value) =>
            setField(key as 'apiKey' | 'model' | 'baseUrl' | 'deployment', value)
          }
        />

        {/* Voice and speed follow the provider (every provider has a different voice
            table), so they stay in this group instead of getting their own section —
            they have to change together when the provider changes. */}
        <VoiceField
          providerId={settings.activeProviderId}
          apiKey={current?.apiKey ?? ''}
          staticVoices={def?.staticVoices ?? []}
          value={current?.voice ?? ''}
          onChange={(value) => setField('voice', value)}
        />

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">语速（0.7 – 1.5）</span>
          <Input
            type="number"
            min={0.7}
            max={1.5}
            step={0.1}
            value={current?.speed ?? 1}
            onChange={(e) => setField('speed', Number(e.target.value))}
          />
        </label>
      </div>
    </section>
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
  // Keep the currently selected voice even when it is not in the list we just fetched
  // (a custom voice id, for example), or merely opening settings once would silently
  // swap out the voice the user picked.
  const options = value && !voices.includes(value) ? [value, ...voices] : voices;

  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs text-[var(--text-soft)]">
        音色
        {loading && <span className="text-[var(--text-faint)]">加载中…</span>}
      </span>
      <SettingSelect
        value={value}
        onValueChange={onChange}
        options={options.map((voice) => ({ value: voice, label: voice }))}
      />
      {error && <p className="text-xs text-[var(--danger)]">音色加载失败，已使用内置列表</p>}
    </label>
  );
}
