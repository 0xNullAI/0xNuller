import { createProviderSettings } from '@0xnullai/llm-providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverBrowserProviderModels,
  testBrowserProviderConnection,
} from './browser-provider-models.js';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  testConnection: vi.fn(),
  listModelsForProvider: vi.fn(),
}));

vi.mock('@dg-agent/providers-openai-http', () => ({
  listModels: mocks.listModels,
  testConnection: mocks.testConnection,
}));

vi.mock('@dg-agent/providers-pi-http', () => ({
  listModelsForProvider: mocks.listModelsForProvider,
}));

describe('browser provider model operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers OpenAI-compatible models through one normalized boundary', async () => {
    mocks.listModels.mockResolvedValue(['gpt-4o-mini']);
    const settings = { ...createProviderSettings('openai'), apiKey: 'sk-test' };

    await expect(discoverBrowserProviderModels(settings)).resolves.toEqual({
      ids: ['gpt-4o-mini'],
    });
    expect(mocks.listModels).toHaveBeenCalledWith({
      baseUrl: settings.baseUrl,
      apiKey: 'sk-test',
    });
  });

  it('loads pi-ai catalogs lazily and returns metadata for the shared settings UI', async () => {
    const details = [{ id: 'claude-test', contextWindow: 1000, maxTokens: 200, reasoning: true }];
    mocks.listModelsForProvider.mockResolvedValue(details);

    await expect(
      discoverBrowserProviderModels({
        ...createProviderSettings('anthropic'),
        apiKey: 'sk-ant-test',
      }),
    ).resolves.toEqual({ ids: ['claude-test'], details });
    expect(mocks.listModelsForProvider).toHaveBeenCalledWith('anthropic');
  });

  it('uses the same OpenAI-compatible boundary for connection probes', async () => {
    const settings = { ...createProviderSettings('custom'), apiKey: 'sk-test' };
    await testBrowserProviderConnection(settings);
    expect(mocks.testConnection).toHaveBeenCalledWith({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    });
  });
});
