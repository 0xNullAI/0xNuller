import { authRequestHeaders } from '@0xnullai/auth';
import {
  createFreeProxyHmacHeaders,
  resolveProviderRequestUrl,
  resolveProviderRuntimeSettings,
  type ProviderDialect,
  type ProviderSettings,
} from '@0xnullai/llm-providers';
import type { LlmClient, LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import { OpenAiHttpLlmClient } from '@dg-agent/providers-openai-http';
import {
  PI_AI_PROVIDER_KEYS,
  type PiAiProviderKey,
} from '@dg-agent/providers-pi-http/provider-keys';

class UnavailableLlmClient implements LlmClient {
  readonly capabilities = { imageInput: false };

  constructor(private readonly message: string) {}

  async runTurn(_input: LlmTurnInput): Promise<LlmTurnResult> {
    throw new Error(this.message);
  }
}

/**
 * Keeps pi-ai and every provider factory outside the normal Agent route. The
 * selected runtime is fetched only when a pi-ai-backed provider starts a turn;
 * OpenAI-compatible providers never download it.
 */
class LazyPiAiLlmClient implements LlmClient {
  readonly capabilities;
  private clientPromise?: Promise<LlmClient>;

  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      providerKey: PiAiProviderKey;
      temperature: number;
      supportsImageInput: boolean;
      transformUrl: (url: string) => string;
    },
  ) {
    this.capabilities = { imageInput: config.supportsImageInput };
  }

  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const client = await this.loadClient();
    return client.runTurn(input);
  }

  private loadClient(): Promise<LlmClient> {
    if (!this.clientPromise) {
      this.clientPromise = import('@dg-agent/providers-pi-http')
        .then(({ PiAiLlmClient }) => new PiAiLlmClient(this.config))
        .catch((error: unknown) => {
          this.clientPromise = undefined;
          throw error;
        });
    }
    return this.clientPromise;
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

/** Close the provider catalog's loose string type against pi-ai's actual registry. */
export function isPiAiProviderKey(value: string): value is PiAiProviderKey {
  return (PI_AI_PROVIDER_KEYS as readonly string[]).includes(value);
}

export function formatProviderConfigError(
  error: unknown,
  providerId: string,
  dialect: ProviderDialect,
): string {
  const providerLabel = `当前服务提供方“${providerId}”`;

  if (dialect === 'openai-compat' && error instanceof Error && /baseUrl/i.test(error.message)) {
    return `${providerLabel}配置无效：接口地址不是有效的 URL`;
  }
  if (dialect === 'pi-ai' && error instanceof Error && /providerKey/i.test(error.message)) {
    return `${providerLabel}配置无效：内部提供方标识不受支持，请重新选择服务提供方或联系开发者`;
  }
  if (dialect === 'pi-ai' && error instanceof Error) {
    return `${providerLabel}配置无效：请检查 API 密钥与模型名称是否填写正确`;
  }
  if (error instanceof Error) return `${providerLabel}配置无效：${error.message}`;
  return `${providerLabel}配置无效，请在设置里检查模型参数`;
}

export interface CreateBrowserLlmClientOptions {
  provider: ProviderSettings;
  temperature?: number;
  freeProxySecret?: string;
}

/** Browser-only provider composition shared by Agent and read-only visual modules. */
export function createBrowserLlmClient(options: CreateBrowserLlmClientOptions): LlmClient {
  const provider = resolveProviderRuntimeSettings(options.provider);
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
  if (provider.dialect === 'pi-ai') {
    if (!provider.piProviderKey || !isPiAiProviderKey(provider.piProviderKey)) {
      return new UnavailableLlmClient(
        `当前服务提供方“${provider.providerId}”配置无效：内部提供方标识不受支持，请重新选择服务提供方或联系开发者`,
      );
    }
    if (
      !provider.model.trim() ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return new UnavailableLlmClient(
        formatProviderConfigError(
          new Error('invalid pi-ai settings'),
          provider.providerId,
          provider.dialect,
        ),
      );
    }
    try {
      return new LazyPiAiLlmClient({
        apiKey: provider.apiKey,
        model: provider.model,
        providerKey: provider.piProviderKey,
        temperature,
        supportsImageInput: provider.imageInput,
        transformUrl: resolveProviderRequestUrl,
      });
    } catch (error) {
      return new UnavailableLlmClient(
        formatProviderConfigError(error, provider.providerId, provider.dialect),
      );
    }
  }
  if (!isValidHttpUrl(provider.baseUrl)) {
    return new UnavailableLlmClient(
      `当前服务提供方“${provider.providerId}”配置无效：接口地址不是有效的 URL`,
    );
  }

  try {
    const signHeaders =
      provider.providerId === 'free' && options.freeProxySecret
        ? createFreeProxyHmacHeaders(options.freeProxySecret)
        : null;
    const extraHeaders =
      provider.providerId === 'free'
        ? async () => ({ ...(signHeaders ? await signHeaders() : {}), ...authRequestHeaders() })
        : undefined;
    return new OpenAiHttpLlmClient({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      endpoint: provider.endpoint,
      useStrict: provider.useStrict,
      temperature,
      extraHeaders,
      supportsImageInput: provider.imageInput,
      transformUrl: resolveProviderRequestUrl,
    });
  } catch (error) {
    return new UnavailableLlmClient(
      formatProviderConfigError(error, provider.providerId, provider.dialect),
    );
  }
}
