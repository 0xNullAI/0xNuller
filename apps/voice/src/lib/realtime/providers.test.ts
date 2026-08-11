import { describe, expect, it } from 'vitest';
import {
  createDefaultRealtimeProviderSettings,
  getRealtimeProviderDefinition,
  normalizeRealtimeProviderSettings,
  REALTIME_PROVIDER_DEFINITIONS,
} from './providers.js';

describe('REALTIME_PROVIDER_DEFINITIONS', () => {
  it('has the four self-BYO-key providers plus the Worker-proxied trial edition', () => {
    expect(REALTIME_PROVIDER_DEFINITIONS.map((p) => p.id).sort()).toEqual([
      'azure',
      'openai',
      'trial',
      'xai',
      'zhipu',
    ]);
  });

  it('trial rides the same openai-realtime (xAI flat) dialect, proxied through the Worker', () => {
    const trial = getRealtimeProviderDefinition('trial');
    expect(trial?.dialect).toBe('openai-realtime');
    // Account authentication is automatic; the model is pinned server-side.
    expect(trial?.fields).toEqual([]);
    // Cost is borne by the provider, so it carries no per-minute price tag.
    expect(trial?.pricePerMinuteUsd).toBeUndefined();
  });

  it('xai/openai/azure share the openai-realtime dialect; zhipu is the lone glm-realtime variant', () => {
    for (const id of ['xai', 'openai', 'azure'] as const) {
      expect(getRealtimeProviderDefinition(id)?.dialect).toBe('openai-realtime');
    }
    expect(getRealtimeProviderDefinition('zhipu')?.dialect).toBe('glm-realtime');
  });

  it('azure is the only provider requiring baseUrl + deployment fields', () => {
    for (const id of ['xai', 'openai', 'zhipu'] as const) {
      const keys = getRealtimeProviderDefinition(id)?.fields.map((f) => f.key) ?? [];
      expect(keys).not.toContain('baseUrl');
      expect(keys).not.toContain('deployment');
    }
    const azureKeys = getRealtimeProviderDefinition('azure')?.fields.map((f) => f.key) ?? [];
    expect(azureKeys).toContain('baseUrl');
    expect(azureKeys).toContain('deployment');
  });
});

describe('createDefaultRealtimeProviderSettings', () => {
  it('seeds the provider default model and first static voice', () => {
    const settings = createDefaultRealtimeProviderSettings('openai');
    expect(settings.model).toBe('gpt-realtime-2.1');
    expect(settings.voice).toBe('alloy');
  });
});

describe('normalizeRealtimeProviderSettings', () => {
  it('falls back to the provider default model when blank', () => {
    const normalized = normalizeRealtimeProviderSettings({
      providerId: 'xai',
      apiKey: '  xai-abc  ',
      model: '   ',
      baseUrl: '',
      deployment: '',
      voice: '',
      speed: 1,
    });
    expect(normalized.apiKey).toBe('xai-abc');
    expect(normalized.model).toBe('grok-voice-think-fast-1.0');
    expect(normalized.voice).toBe('ara');
  });

  it('strips a trailing slash from baseUrl', () => {
    const normalized = normalizeRealtimeProviderSettings({
      providerId: 'azure',
      apiKey: 'k',
      model: 'gpt-realtime-2.1',
      baseUrl: 'https://my-resource.openai.azure.com/',
      deployment: 'my-deploy',
      voice: 'alloy',
      speed: 1,
    });
    expect(normalized.baseUrl).toBe('https://my-resource.openai.azure.com');
  });

  it('clamps speed into the 0.7-1.5 supported range', () => {
    const tooFast = normalizeRealtimeProviderSettings({
      providerId: 'openai',
      apiKey: 'k',
      model: 'gpt-realtime-2.1',
      baseUrl: '',
      deployment: '',
      voice: 'alloy',
      speed: 5,
    });
    expect(tooFast.speed).toBe(1.5);

    const tooSlow = normalizeRealtimeProviderSettings({
      providerId: 'openai',
      apiKey: 'k',
      model: 'gpt-realtime-2.1',
      baseUrl: '',
      deployment: '',
      voice: 'alloy',
      speed: 0.1,
    });
    expect(tooSlow.speed).toBe(0.7);
  });
});
