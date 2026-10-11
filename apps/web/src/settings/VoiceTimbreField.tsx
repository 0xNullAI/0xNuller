import { useState } from 'react';
import { SelectRow } from './settings-list';
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
    <SelectRow
      label="音色"
      value={settings.voice}
      onChange={(voice) => {
        const next = { ...settings, voice };
        setSettings(next);
        saveSettings(next);
      }}
      options={MANAGED_VOICES.map((voice) => ({ value: voice.id, label: voice.label }))}
    />
  );
}
