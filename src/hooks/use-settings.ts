import { useCallback, useState } from 'react';
import { loadSettings, saveSettings, type VoiceSettings } from '@/lib/settings';

/**
 * Settings save on every change (there is no drawer-close gesture to hook
 * like DG-Agent's `use-settings-manager` — DG-Voice's settings live in a
 * `Sheet`, and the call screen needs the latest value the instant it opens).
 */
export function useSettings() {
  const [settings, setSettingsState] = useState<VoiceSettings>(() => loadSettings());

  const updateSettings = useCallback((updater: (prev: VoiceSettings) => VoiceSettings) => {
    setSettingsState((prev) => {
      const next = updater(prev);
      saveSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
