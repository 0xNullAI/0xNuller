import { describe, expect, it } from 'vitest';
import { createProviderSettings, normalizeProviderSettings } from '@0xnullai/llm-providers';
import { defaultBrowserAppSettings } from '@dg-agent/storage-browser';
import { buildWarnings } from '../utils/runtime-warnings.js';

const MODES = {
  deviceMode: 'web-bluetooth' as const,
  llmMode: 'provider-http' as const,
  bluetoothAvailability: { supported: true },
  permissionMode: 'confirm' as const,
  providerId: 'custom' as const,
};

const SPEECH = {
  recognitionSupported: true,
  synthesisSupported: true,
  recognitionMode: 'browser' as const,
  synthesisMode: 'browser' as const,
  nativeRecognitionSupported: true,
  nativeSynthesisSupported: true,
  proxyRecognitionSupported: false,
  proxySynthesisSupported: false,
};

const BASE_URL_WARNING = '当前模型接口地址无效，请在设置里检查接口地址';

describe('buildWarnings', () => {
  it('does not warn about the managed service address', () => {
    const settings = {
      ...defaultBrowserAppSettings(),
      llmMode: 'provider-http' as const,
      provider: createProviderSettings('managed'),
    };

    expect(buildWarnings(settings, MODES, SPEECH)).not.toContain(BASE_URL_WARNING);
  });

  it('warns about an invalid custom endpoint address', () => {
    const settings = {
      ...defaultBrowserAppSettings(),
      llmMode: 'provider-http' as const,
      provider: {
        ...normalizeProviderSettings({ ...createProviderSettings('custom'), apiKey: 'sk-test' }),
        baseUrl: 'not-a-url',
      },
    };

    const warnings = buildWarnings(settings, MODES, SPEECH);

    expect(warnings).toContain(BASE_URL_WARNING);
  });
});
