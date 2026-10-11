import { authRequestHeaders } from '@0xnullai/auth';
import {
  resolveProviderRequestUrl,
  resolveProviderRuntimeSettings,
  type ProviderSettings,
} from '@0xnullai/llm-providers';
import type { LlmClient, LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import { OpenAiHttpLlmClient } from '@dg-agent/providers-openai-http';

class UnavailableLlmClient implements LlmClient {
  readonly capabilities = { imageInput: false };
  private readonly message: string;

  constructor(message: string) {
    this.message = message;
  }

  async runTurn(_input: LlmTurnInput): Promise<LlmTurnResult> {
    throw new Error(this.message);
  }
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function formatProviderConfigError(error: unknown, providerId: string): string {
  const providerLabel = `当前服务提供方“${providerId}”`;

  if (error instanceof Error && /baseUrl/i.test(error.message)) {
    return `${providerLabel}配置无效：接口地址不是有效的 URL`;
  }
  if (error instanceof Error) return `${providerLabel}配置无效：${error.message}`;
  return `${providerLabel}配置无效，请在设置里检查模型参数`;
}

export interface CreateBrowserLlmClientOptions {
  provider: ProviderSettings;
  temperature?: number;
  attachPrivateConversation?: boolean;
}

/** Browser-only provider composition shared by Agent and read-only visual modules. */
export function createBrowserLlmClient(options: CreateBrowserLlmClientOptions): LlmClient {
  let provider;
  try {
    provider = resolveProviderRuntimeSettings(options.provider);
  } catch (error) {
    return new UnavailableLlmClient(formatProviderConfigError(error, options.provider.providerId));
  }
  const temperature = options.temperature ?? 0.3;

  if (!provider.browserSupported) {
    return new UnavailableLlmClient(
      `当前服务提供方“${provider.providerId}”不支持浏览器直连，请改用可在浏览器运行的服务`,
    );
  }
  if (!provider.apiKey) {
    return new UnavailableLlmClient(
      '当前模型服务还没有配置完成，请先在设置里选择服务提供方并补全凭证',
    );
  }
  if (!isValidHttpUrl(provider.baseUrl)) {
    return new UnavailableLlmClient(
      `当前服务提供方“${provider.providerId}”配置无效：接口地址不是有效的 URL`,
    );
  }

  try {
    const extraHeaders =
      provider.providerId === 'managed' ? async () => authRequestHeaders() : undefined;
    return new OpenAiHttpLlmClient({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      endpoint: provider.endpoint,
      useStrict: provider.useStrict,
      temperature,
      extraHeaders,
      attachPrivateConversation: options.attachPrivateConversation === true,
      supportsImageInput: provider.imageInput,
      transformUrl: resolveProviderRequestUrl,
    });
  } catch (error) {
    return new UnavailableLlmClient(formatProviderConfigError(error, provider.providerId));
  }
}
