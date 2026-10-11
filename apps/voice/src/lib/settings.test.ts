import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MANAGED_VOICE } from './realtime/managed-voices';
import { loadSettings, saveSettings, SETTINGS_STORAGE_KEY } from './settings';

const SAFETY = {
  permissionMode: 'confirm',
  coyoteSafety: {
    maxStrengthA: 50,
    maxStrengthB: 50,
    maxColdStartStrength: 10,
    maxAdjustStep: 10,
    maxBurstDurationMs: 5000,
    maxBurstStrengthAbsolute: 0,
    maxBurstStrengthRelative: 0,
  },
  opossumSafety: {
    maxColdStartIntensity: 10,
    maxAdjustStep: 10,
    maxIntensityA: 50,
    maxIntensityB: 50,
  },
};

function legacyProvider(providerId: string, voice: string) {
  return {
    providerId,
    apiKey: `${providerId}-secret`,
    model: 'm',
    baseUrl: '',
    deployment: '',
    voice,
    speed: 1.2,
  };
}

afterEach(() => localStorage.clear());

describe('voice settings from versions with bring-your-own-key providers', () => {
  it.each(['xai', 'openai', 'azure', 'zhipu'])(
    'loads a stored %s selection as the managed service and keeps its voice',
    (providerId) => {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          ...SAFETY,
          activeProviderId: providerId,
          providers: {
            managed: legacyProvider('managed', 'rex'),
            [providerId]: legacyProvider(providerId, 'tongtong'),
          },
        }),
      );

      const settings = loadSettings();

      expect(settings.voice).toBe('rex');
      expect(settings).not.toHaveProperty('activeProviderId');
      expect(settings).not.toHaveProperty('providers');
      expect(JSON.stringify(settings)).not.toContain('secret');
    },
  );

  it('falls back to the default voice when only a removed provider was stored', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...SAFETY,
        activeProviderId: 'zhipu',
        providers: { zhipu: legacyProvider('zhipu', 'tongtong') },
      }),
    );

    expect(loadSettings().voice).toBe(DEFAULT_MANAGED_VOICE);
  });

  it('carries the voice of the pre-managed trial entry', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ activeProviderId: 'trial', providers: { trial: { voice: 'leo' } } }),
    );

    expect(loadSettings().voice).toBe('leo');
  });

  it('drops legacy provider keys from storage on the next save', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...SAFETY,
        activeProviderId: 'openai',
        providers: { openai: legacyProvider('openai', 'alloy') },
      }),
    );

    saveSettings({ ...loadSettings(), voice: 'sal' });

    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!) as Record<
      string,
      unknown
    >;
    expect(stored.voice).toBe('sal');
    expect(stored).not.toHaveProperty('providers');
    expect(loadSettings().voice).toBe('sal');
  });
});
