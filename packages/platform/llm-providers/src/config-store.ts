import type { ProviderId } from './index';
import { FREE_TRIAL_MODEL, FREE_TRIAL_PROXY_URL, getProviderDefinition } from './index';

/**
 * 跨模块共享的 LLM 配置。
 *
 * 合并前 DG-Agent 与 DG-Chat 各存一份，形态却是完全一样的四个字段
 * （providerId / apiKey / model / baseUrl）。用户在 Agent 里配好 provider，
 * 到 Chat 里还得再配一遍——这正是「一个软件」要消掉的摩擦。
 *
 * DG-Voice 的 realtime provider 配置**不**并进来：它是另一个领域（语音会话的
 * 端点与鉴权方式都不同），形态也不同。硬凑只会让两边都别扭。
 *
 * API Key 存在 localStorage 里，与合并前各模块的做法一致。这不是加密存储——
 * 同源脚本读得到，浏览器扩展也读得到。真正需要保密的部署应该用自建代理，
 * 让密钥只存在于服务端（免费 provider 就是这么做的）。
 */

export interface LlmConfig {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const KEY = '0xnullai.llm-config';
/** 合并前各模块自己的键，用于一次性迁移。 */
const LEGACY_KEYS = ['dg-chat-ai-config', 'dg-agent.provider-settings'];

const listeners = new Set<(c: LlmConfig) => void>();

export function defaultLlmConfig(): LlmConfig {
  return {
    providerId: 'free',
    apiKey: '',
    model: FREE_TRIAL_MODEL,
    baseUrl: FREE_TRIAL_PROXY_URL,
  };
}

function coerce(raw: unknown): LlmConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.providerId !== 'string') return null;
  return {
    providerId: o.providerId,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    model: typeof o.model === 'string' ? o.model : '',
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
  };
}

export function loadLlmConfig(): LlmConfig {
  if (typeof localStorage === 'undefined') return defaultLlmConfig();
  try {
    const own = coerce(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
    if (own) return own;
    // 一次性迁移：读到旧键就搬过来并写入新键，之后不再回头读旧键。
    for (const legacy of LEGACY_KEYS) {
      const old = coerce(JSON.parse(localStorage.getItem(legacy) ?? 'null'));
      if (old) {
        saveLlmConfig(old);
        return old;
      }
    }
  } catch {
    // 存储被污染时回落默认值，而不是让整个模块崩在启动阶段。
  }
  return defaultLlmConfig();
}

export function saveLlmConfig(config: LlmConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // 隐私模式 / 配额满：配置存不下不该阻断使用，本次会话内仍然生效。
  }
  for (const l of listeners) l(config);
}

/**
 * 订阅配置变化。同一文档内的改动走 listeners，跨标签页走 storage 事件——
 * 后者是「在 Agent 标签页改了 provider，Chat 标签页跟着变」的实现。
 */
export function subscribeLlmConfig(listener: (c: LlmConfig) => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener(loadLlmConfig());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** 配置是否可用。免费 provider 不需要 key，其余需要。 */
export function isLlmConfigured(c: LlmConfig): boolean {
  if (c.providerId === 'free') return true;
  const def = getProviderDefinition(c.providerId as ProviderId);
  const needsKey = def ? def.fields.some((f) => f.key === 'apiKey') : true;
  return needsKey ? c.apiKey.trim().length > 0 : true;
}
