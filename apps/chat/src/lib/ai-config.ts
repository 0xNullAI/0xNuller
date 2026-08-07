// AI / LLM 供应商配置：房主选择房间内 AI 代理使用的大模型。
// 改编自 DG-Agent 的 providers-catalog（packages/providers-catalog/src/index.ts），
// 但裁剪为 DG-Chat 自用的最小集合，且不依赖 React / zod，供 agent loop 直接 import。

/** 当前生效的 AI 配置（持久化到 localStorage）。 */
export interface AiConfig {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 供应商预设：用于下拉选择并预填 baseUrl / model。 */
export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
}

/** 免费代理地址（0xNullAI 提供，无需 API Key）。 */
export const FREE_PROXY_URL = 'https://llm.0xnullai.com';

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'free',
    label: '免费代理（0xNullAI）',
    baseUrl: FREE_PROXY_URL,
    defaultModel: 'openrouter/free',
    needsKey: false,
  },
  {
    id: 'qwen',
    label: 'Qwen（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.5-plus',
    needsKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    needsKey: true,
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-mini-250415',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
  },
];

const STORAGE_KEY = 'dg-chat-ai-config';

/** 免费预设作为默认配置（永远可用，无需配置）。 */
function defaultConfig(): AiConfig {
  const free = AI_PROVIDER_PRESETS[0];
  return {
    providerId: free.id,
    baseUrl: free.baseUrl,
    model: free.defaultModel,
    apiKey: '',
  };
}

export function getPreset(id: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

/** 读取已保存的配置；无配置或解析失败时回退到免费预设。 */
export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : 'free',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return defaultConfig();
  }
}

export function saveAiConfig(c: AiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // 写入失败（隐私模式 / 配额）时静默忽略，不阻断流程。
  }
}

/** 配置是否可用于发起请求：免费预设永远可用，其余需 apiKey + model + baseUrl。 */
export function isAiConfigured(c: AiConfig): boolean {
  if (c.providerId === 'free') return true;
  return Boolean(c.apiKey.trim() && c.model.trim() && c.baseUrl.trim());
}
