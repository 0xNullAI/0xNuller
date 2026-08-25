import {
  getProviderDefinition,
  resolveProviderRequestUrl,
  type ProviderSettings,
} from '@0xnullai/llm-providers';
import { listModels, testConnection } from '@dg-agent/providers-openai-http';
import type { PiAiModelInfo } from '@dg-agent/providers-pi-http';
import { isPiAiProviderKey } from './create-browser-llm-client.js';

export interface BrowserProviderModelCatalog {
  ids: string[];
  details?: PiAiModelInfo[];
}

/**
 * One dialect-aware model discovery boundary for Agent and Video settings.
 * Provider SDK loading stays lazy; callers may apply a stricter capability
 * filter (Video's image allowlist) after discovery.
 */
export async function discoverBrowserProviderModels(
  settings: ProviderSettings,
): Promise<BrowserProviderModelCatalog> {
  const definition = getProviderDefinition(settings.providerId);
  if (!definition?.browserSupported) {
    throw new Error('当前服务提供方不支持浏览器模型发现');
  }
  if (definition.dialect === 'pi-ai') {
    if (!definition.piProviderKey || !isPiAiProviderKey(definition.piProviderKey)) {
      throw new Error('当前服务提供方的内部标识不受支持');
    }
    const { listModelsForProvider } = await import('@dg-agent/providers-pi-http');
    const details = await listModelsForProvider(definition.piProviderKey);
    return { ids: details.map((model) => model.id), details };
  }
  return {
    ids: await listModels({
      baseUrl: resolveProviderRequestUrl(settings.baseUrl),
      apiKey: settings.apiKey,
    }),
  };
}

/** OpenAI-compatible connection probe with the same global proxy routing as real turns. */
export async function testBrowserProviderConnection(settings: ProviderSettings): Promise<void> {
  const definition = getProviderDefinition(settings.providerId);
  if (!definition?.browserSupported || definition.dialect !== 'openai-compat') {
    throw new Error('当前服务提供方不使用 OpenAI 兼容连接测试');
  }
  await testConnection({
    baseUrl: resolveProviderRequestUrl(settings.baseUrl),
    apiKey: settings.apiKey,
    model: settings.model,
  });
}
