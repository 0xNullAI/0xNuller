import {
  getProviderDefinition,
  resolveProviderRequestUrl,
  type ProviderSettings,
} from '@0xnullai/llm-providers';
import { listModels, testConnection } from '@dg-agent/providers-openai-http';

/** Model ids reported by the user's OpenAI-compatible endpoint, for Agent and Video settings. */
export async function discoverBrowserProviderModels(settings: ProviderSettings): Promise<string[]> {
  const definition = getProviderDefinition(settings.providerId);
  if (!definition?.browserSupported || settings.providerId !== 'custom') {
    throw new Error('当前服务提供方不支持浏览器模型发现');
  }
  return listModels({
    baseUrl: resolveProviderRequestUrl(settings.baseUrl),
    apiKey: settings.apiKey,
  });
}

/** OpenAI-compatible connection probe with the same global proxy routing as real turns. */
export async function testBrowserProviderConnection(settings: ProviderSettings): Promise<void> {
  const definition = getProviderDefinition(settings.providerId);
  if (!definition?.browserSupported || settings.providerId !== 'custom') {
    throw new Error('当前服务提供方不使用 OpenAI 兼容连接测试');
  }
  await testConnection({
    baseUrl: resolveProviderRequestUrl(settings.baseUrl),
    apiKey: settings.apiKey,
    model: settings.model,
  });
}
