import { useState } from 'react';
import { SettingSelect } from '@0xnullai/ui';
import { MANAGED_VOICES } from '../../../voice/src/lib/realtime/managed-voices';
import { loadSettings, saveSettings } from '../../../voice/src/lib/settings';

/**
 * The account default voice for 猫愿语音. Reads and writes Voice's settings module
 * directly instead of copying its shape: a copy is another source of truth.
 */
export function VoiceTimbreField() {
  // Each settings page mounts when it opens, so reading once is current.
  const [settings, setSettings] = useState(loadSettings);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--text-soft)]">音色</span>
      <SettingSelect
        value={settings.voice}
        onValueChange={(voice) => {
          const next = { ...settings, voice };
          setSettings(next);
          saveSettings(next);
        }}
        options={MANAGED_VOICES.map((voice) => ({ value: voice.id, label: voice.label }))}
      />
    </label>
  );
}
