import { useCallback, useState } from 'react';
import { createDefaultSettings, loadSettings, saveSettings, type VoiceSettings } from '@/lib/settings';

/**
 * Settings save on every change (the call screen needs the latest value the
 * instant it opens, and — unlike DG-Agent's `use-settings-manager` — DG-Voice
 * has no close gesture to flush on, since the settings panel and the call
 * screen coexist in the same shell).
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

  const resetSettings = useCallback(() => {
    const defaults = createDefaultSettings();
    saveSettings(defaults);
    setSettingsState(defaults);
  }, []);

  return { settings, updateSettings, resetSettings };
}
