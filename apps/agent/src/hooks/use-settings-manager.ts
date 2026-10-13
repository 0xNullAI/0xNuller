import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserAppSettingsStore, type BrowserAppSettings } from '@dg-agent/storage-browser';
import { subscribeLlmConfig } from '@0xnullai/llm-providers';
import { subscribeDeviceSafety } from '@0xnullai/settings';

interface UseSettingsManagerResult {
  settingsDraft: BrowserAppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settings: BrowserAppSettings;
  setSettings: React.Dispatch<React.SetStateAction<BrowserAppSettings>>;
  settingsStore: BrowserAppSettingsStore;
  resetSettings: (onDone: () => void) => void;
  flushSettingsDraft: () => void;
}

export function useSettingsManager(): UseSettingsManagerResult {
  const settingsStore = useMemo(
    () =>
      new BrowserAppSettingsStore({
        env: import.meta.env,
      }),
    [],
  );
  const initialSettings = useMemo(() => settingsStore.load(), [settingsStore]);
  const [settingsDraft, setSettingsDraft] = useState<BrowserAppSettings>(initialSettings);
  const [settings, setSettings] = useState<BrowserAppSettings>(initialSettings);

  useEffect(
    () =>
      settingsStore.subscribeModelBehavior((behavior) => {
        // Keep the same object when nothing changed: a fresh one re-renders the whole app.
        setSettings((current) => withModelBehavior(current, behavior));
        setSettingsDraft((current) => withModelBehavior(current, behavior));
      }),
    [settingsStore],
  );

  useEffect(() => {
    const reload = () => {
      const next = settingsStore.load();
      setSettings(next);
      setSettingsDraft(next);
    };
    const unsubscribeLlm = subscribeLlmConfig(reload);
    const unsubscribeSafety = subscribeDeviceSafety(reload);
    return () => {
      unsubscribeLlm();
      unsubscribeSafety();
    };
  }, [settingsStore]);

  function resetSettings(onDone: () => void): void {
    const next = settingsStore.reset();
    setSettingsDraft(next);
    setSettings(next);
    onDone();
  }

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (JSON.stringify(settingsDraft) === JSON.stringify(settings)) return;

    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      const next = settingsStore.save(settingsDraft);
      setSettings(next);
    }, 300);

    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [settingsDraft, settings, settingsStore]);

  function flushSettingsDraft(): void {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (JSON.stringify(settingsDraft) !== JSON.stringify(settings)) {
      const next = settingsStore.save(settingsDraft);
      setSettings(next);
      setSettingsDraft(next);
    }
  }

  return {
    settingsDraft,
    setSettingsDraft,
    settings,
    setSettings,
    settingsStore,
    resetSettings,
    flushSettingsDraft,
  };
}

/** Apply a model-behavior update, returning `current` itself when every value already matches. */
export function withModelBehavior(
  current: BrowserAppSettings,
  behavior: Partial<BrowserAppSettings>,
): BrowserAppSettings {
  const changed = (Object.keys(behavior) as Array<keyof BrowserAppSettings>).some(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(behavior[key]),
  );
  return changed ? { ...current, ...behavior } : current;
}
