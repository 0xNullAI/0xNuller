import { applyHttpProxy } from '@0xnullai/settings';
import { z } from 'zod';
import { migrateLegacyProviderSettings } from './legacy-provider-migration';

/**
 * The platform's managed plan provides every AI capability. A user's own key
 * ("BYOK") goes through exactly one OpenAI-compatible `custom` endpoint; image
 * input there is an explicit user opt-in.
 */
export type ProviderId = 'managed' | 'custom';
export type ProviderEndpoint = 'responses' | 'chat/completions';

export interface ProviderFieldDefinition {
  key: 'apiKey' | 'model' | 'baseUrl' | 'endpoint' | 'useStrict';
  label: string;
  type: 'password' | 'text' | 'url' | 'select';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  hint?: string;
  browserSupported: boolean;
  fields: ProviderFieldDefinition[];
}

export interface ProviderSettings {
  providerId: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: ProviderEndpoint;
  useStrict: boolean;
  /**
   * The user's own statement that the `custom` model accepts images. Defaults to
   * off and is ignored for `managed`, whose vision model is declared below.
   */
  imageInput: boolean;
}

export interface ProviderRuntimeSettings extends ProviderSettings {
  browserSupported: boolean;
}

const PROVIDER_IDS = ['managed', 'custom'] as const satisfies ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return (PROVIDER_IDS as readonly unknown[]).includes(value);
}

// These seed every freshly created provider config. `normalizeProviderSettings`
// overrides them for `managed`; for `custom` they are the Chat-Completions +
// non-strict, text-only defaults.
const BASE_PROVIDER_SETTINGS = {
  apiKey: '',
  model: '',
  baseUrl: '',
  endpoint: 'chat/completions' as const,
  useStrict: false,
  imageInput: false,
};

const providerSettingsSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  endpoint: z.enum(['responses', 'chat/completions']),
  useStrict: z.boolean(),
  imageInput: z.boolean(),
});

export const MANAGED_SERVICE_URL = 'https://llm.0xnullai.com';

/** Stable public model ids; the Worker maps every text id to one Ark model. */
export const MANAGED_DEFAULT_MODEL = 'balanced';
/** The only managed model that accepts a transient Video camera frame. */
export const MANAGED_VISION_MODEL = 'vision';
export const MANAGED_MODEL_OPTIONS = [
  {
    id: 'basic',
    name: '基础',
    description: '轻量实用，适合日常聊天和简单操作',
  },
  {
    id: 'balanced',
    name: '均衡',
    description: '质量与价格平衡，适合多数 Agent 任务',
  },
  {
    id: 'powerful',
    name: '强力',
    description: '适合复杂推理、长任务和多步工具调用',
  },
] as const;

export function isManagedModelId(model: string): boolean {
  return (
    model === MANAGED_VISION_MODEL || MANAGED_MODEL_OPTIONS.some((option) => option.id === model)
  );
}

const CUSTOM_PLACEHOLDER_BASE_URL = 'https://api.example.com/v1';

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: 'managed',
    name: '猫愿模型',
    hint: '登录后使用 Credit，费用按实际模型用量结算。',
    browserSupported: true,
    fields: [],
  },
  {
    id: 'custom',
    name: '自定义',
    hint: 'OpenAI 兼容接口',
    browserSupported: true,
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'model-name' },
      { key: 'baseUrl', label: '接口地址', type: 'url', placeholder: CUSTOM_PLACEHOLDER_BASE_URL },
      {
        key: 'endpoint',
        label: '接口类型',
        type: 'select',
        options: [
          { value: 'responses', label: 'Responses 接口' },
          { value: 'chat/completions', label: 'Chat Completions 接口' },
        ],
      },
      {
        key: 'useStrict',
        label: '严格 Schema',
        type: 'select',
        options: [
          { value: 'true', label: '开启' },
          { value: 'false', label: '关闭' },
        ],
      },
    ],
  },
];

/**
 * Image support for one config. Managed accepts images only on its declared vision
 * model; custom only after the user switched it on. Everything else fails closed.
 */
export function supportsProviderImageInput(
  settings: Pick<ProviderSettings, 'providerId' | 'model' | 'imageInput'>,
): boolean {
  const model = settings.model.trim();
  if (settings.providerId === 'managed') return model === MANAGED_VISION_MODEL;
  if (settings.providerId === 'custom') return settings.imageInput === true && model.length > 0;
  return false;
}

export function getProviderDefinition(id: ProviderId): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((provider) => provider.id === id);
}

export function createProviderSettings(providerId: ProviderId): ProviderSettings {
  return normalizeProviderSettings({
    ...BASE_PROVIDER_SETTINGS,
    providerId,
  });
}

export function createDefaultProviderSettings(): ProviderSettings {
  return createProviderSettings('managed');
}

export function normalizeProviderSettings(input: ProviderSettings): ProviderSettings {
  // Persisted data may still name a removed provider (cast to `ProviderId` on the
  // way in). Migrate it here instead of letting the schema below throw.
  const normalized: ProviderSettings = isProviderId(input.providerId)
    ? { ...input }
    : migrateLegacyProviderSettings(input);

  // Trim before the default-fallback checks below, once, at the single place every
  // persisted/draft value passes through, so readers see the id the request uses.
  normalized.model = typeof normalized.model === 'string' ? normalized.model.trim() : '';
  normalized.apiKey = typeof normalized.apiKey === 'string' ? normalized.apiKey : '';
  normalized.baseUrl = typeof normalized.baseUrl === 'string' ? normalized.baseUrl : '';
  normalized.imageInput = normalized.imageInput === true;

  if (normalized.providerId === 'managed') {
    normalized.baseUrl = MANAGED_SERVICE_URL + '/v1';
    normalized.model = isManagedModelId(normalized.model)
      ? normalized.model
      : MANAGED_DEFAULT_MODEL;
    normalized.endpoint = 'chat/completions';
    normalized.useStrict = false;
    normalized.imageInput = false;
  } else {
    // endpoint/useStrict/imageInput stay user-editable: only fill a missing
    // endpoint and never clobber the user's toggles.
    normalized.baseUrl = normalized.baseUrl || CUSTOM_PLACEHOLDER_BASE_URL;
    normalized.model = normalized.model || 'model-name';
    normalized.endpoint = normalized.endpoint === 'responses' ? 'responses' : 'chat/completions';
    normalized.useStrict = normalized.useStrict === true;
  }

  normalized.baseUrl = normalized.baseUrl.replace(/\/+$/, '');
  return providerSettingsSchema.parse(normalized);
}

export function providerRequiresUserApiKey(settingsOrId: ProviderSettings | ProviderId): boolean {
  const providerId = typeof settingsOrId === 'string' ? settingsOrId : settingsOrId.providerId;
  const definition = getProviderDefinition(providerId);
  return Boolean(definition?.fields.some((field) => field.key === 'apiKey'));
}

export function resolveProviderRequestUrl(url: string): string {
  return applyHttpProxy(url);
}

export function resolveProviderRuntimeSettings(input: ProviderSettings): ProviderRuntimeSettings {
  const normalized = normalizeProviderSettings(input);
  const runtime = {
    ...normalized,
    imageInput: supportsProviderImageInput(normalized),
  };

  if (normalized.providerId === 'managed') {
    return { ...runtime, apiKey: 'managed', browserSupported: true };
  }
  return { ...runtime, browserSupported: isProviderUsableInBrowser(normalized) };
}

export function isProviderUsableInBrowser(settings: ProviderSettings): boolean {
  const definition = getProviderDefinition(settings.providerId);
  return Boolean(definition?.browserSupported);
}

export * from './config-store';
export * from './legacy-provider-migration';
export * from './video-config-store';
