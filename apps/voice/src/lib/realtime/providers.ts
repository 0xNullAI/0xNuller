/**
 * Realtime voice provider catalog. Deliberately small compared to
 * DG-Agent's ~23-provider `providers-catalog` — the filter here is
 * "bidirectional realtime speech + in-session tool calling + runtime tool
 * declaration + browser-direct (no relay) + small adapter", which only
 * xAI/OpenAI/Azure (one client, `openai-realtime` dialect) and Zhipu GLM
 * (`glm-realtime`, one variant) clear. See DG-Voice/CLAUDE.md for the full
 * list of providers considered and why each excluded one didn't qualify.
 *
 * NOT LIVE-VERIFIED: the exact voice id lists below are transcribed from
 * each provider's public docs at write time, not fetched from a live key.
 * xAI is marked `voiceSource: 'api'` specifically because DG-Voice re-fetches
 * its list from `GET /v1/tts/voices` at runtime rather than trusting a
 * hardcoded snapshot — the others don't expose an equivalent endpoint.
 */

/**
 * `trial` (体验版) is xAI Grok reached through DG-Voice's own Cloudflare
 * Worker (`/api/realtime`) instead of `api.x.ai` directly: the real xAI key
 * lives only as a Worker secret, and the user pastes an "activation key" that
 * the Worker validates + meters (session-length / daily caps) before opening
 * the upstream connection with the real key. On the wire past the Worker it
 * is plain `openai-realtime` (xAI flat shape), so the frontend adapter is a
 * two-line branch — see `openai-realtime-session.ts`.
 */
export type RealtimeProviderId = 'trial' | 'xai' | 'openai' | 'azure' | 'zhipu';

/**
 * Which wire dialect a provider's realtime WebSocket speaks:
 * - `openai-realtime`: xAI/OpenAI/Azure all speak the same event shapes
 *   (`session.update`, `input_audio_buffer.append`,
 *   `response.output_audio.delta`, `response.function_call_arguments.done`,
 *   `response.create`). One client, zero per-provider branching beyond
 *   connection setup.
 * - `glm-realtime`: Zhipu's variant — wav audio instead of pcm16,
 *   `client_vad`/`server_vad` naming, `tts_source`/`chat_mode` fields, a
 *   30s heartbeat event, and per-call-id aggregation of `.done`-only
 *   function-call argument events (no `.delta`).
 */
export type RealtimeDialect = 'openai-realtime' | 'glm-realtime';

export interface RealtimeProviderFieldDefinition {
  key: 'apiKey' | 'model' | 'baseUrl' | 'deployment';
  label: string;
  type: 'password' | 'text' | 'url';
  placeholder?: string;
}

export interface RealtimeProviderDefinition {
  id: RealtimeProviderId;
  name: string;
  hint?: string;
  dialect: RealtimeDialect;
  defaultModel: string;
  fields: RealtimeProviderFieldDefinition[];
  /** Rough cost signal shown next to the provider in settings; not billed by DG-Voice itself. */
  pricePerMinuteUsd?: number;
  voiceSource: 'api' | 'static';
  staticVoices?: string[];
}

export interface RealtimeProviderSettings {
  providerId: RealtimeProviderId;
  apiKey: string;
  model: string;
  /** Azure only: resource endpoint, e.g. `https://your-resource.openai.azure.com`. */
  baseUrl: string;
  /** Azure only: deployment name, sent as `session.model` instead of a model id. */
  deployment: string;
  voice: string;
  /** 0.7–1.5, per xAI/OpenAI's supported speaking-rate range. */
  speed: number;
}

const XAI_STATIC_VOICES = ['ara', 'eve', 'leo', 'rex', 'sal'];
// Trial can't hit `GET /v1/tts/voices` from the browser (no real key there),
// so it ships a fixed subset of xAI's legacy voices; `eve` is xAI's default.
const TRIAL_STATIC_VOICES = ['eve', 'ara', 'leo', 'rex', 'sal'];
const OPENAI_STATIC_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'marin',
  'sage',
  'shimmer',
  'verse',
];
// Verified against Zhipu's GLM-Realtime docs:
// https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime
// The previous list had several Azure-style names (xiaoxiao/xiaoyun/yunyang/
// yunxi/yunfeng) that don't exist on Zhipu — a call would fail as soon as one
// was selected. `tongtong` is Zhipu's documented default.
const ZHIPU_STATIC_VOICES = [
  'tongtong',
  'xiaochen',
  'female-tianmei',
  'female-shaonv',
  'male-qn-daxuesheng',
  'male-qn-jingying',
  'lovely_girl',
];

export const REALTIME_PROVIDER_DEFINITIONS: RealtimeProviderDefinition[] = [
  {
    id: 'trial',
    name: '体验版（免自带 Key）',
    hint: '额度由 0xNullAI 提供：填入拿到的激活密钥即可试用 Grok，单次通话有时长上限、每日有总量上限。',
    dialect: 'openai-realtime',
    // Pinned by the Worker upstream; the trial user can't change it.
    defaultModel: 'grok-voice-think-fast-1.0',
    voiceSource: 'static',
    staticVoices: TRIAL_STATIC_VOICES,
    fields: [{ key: 'apiKey', label: '激活密钥', type: 'password', placeholder: 'dgv-trial-...' }],
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    hint: '26 个内置音色 + 自定义音色选用，$0.05/分钟',
    dialect: 'openai-realtime',
    defaultModel: 'grok-voice-think-fast-1.0',
    pricePerMinuteUsd: 0.05,
    voiceSource: 'api',
    staticVoices: XAI_STATIC_VOICES,
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'xai-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'grok-voice-think-fast-1.0' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI Realtime',
    hint: '与 xAI 同一套客户端，约 $0.096/分钟',
    dialect: 'openai-realtime',
    defaultModel: 'gpt-realtime-2.1',
    pricePerMinuteUsd: 0.096,
    voiceSource: 'static',
    staticVoices: OPENAI_STATIC_VOICES,
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-realtime-2.1' },
    ],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI Realtime',
    hint: '纯配置差异：填资源地址 + 部署名，鉴权用 api-key',
    dialect: 'openai-realtime',
    defaultModel: 'gpt-realtime-2.1',
    voiceSource: 'static',
    staticVoices: OPENAI_STATIC_VOICES,
    fields: [
      { key: 'apiKey', label: 'API 密钥', type: 'password', placeholder: 'Azure API 密钥' },
      {
        key: 'baseUrl',
        label: '资源地址',
        type: 'url',
        placeholder: 'https://your-resource.openai.azure.com',
      },
      { key: 'deployment', label: '部署名', type: 'text', placeholder: 'gpt-realtime-2-1-deploy' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM-Realtime',
    hint: '本地签 JWT，无需任何网络换票；约 ¥0.18-0.30/分钟',
    dialect: 'glm-realtime',
    defaultModel: 'glm-realtime-flash',
    voiceSource: 'static',
    staticVoices: ZHIPU_STATIC_VOICES,
    fields: [
      {
        key: 'apiKey',
        label: 'API 密钥',
        type: 'password',
        placeholder: '{id}.{secret}（控制台复制的完整密钥）',
      },
      { key: 'model', label: '模型', type: 'text', placeholder: 'glm-realtime-flash' },
    ],
  },
];

export function getRealtimeProviderDefinition(
  id: RealtimeProviderId,
): RealtimeProviderDefinition | undefined {
  return REALTIME_PROVIDER_DEFINITIONS.find((provider) => provider.id === id);
}

export function createDefaultRealtimeProviderSettings(
  providerId: RealtimeProviderId = 'xai',
): RealtimeProviderSettings {
  const definition = getRealtimeProviderDefinition(providerId);
  return {
    providerId,
    apiKey: '',
    model: definition?.defaultModel ?? '',
    baseUrl: '',
    deployment: '',
    voice: definition?.staticVoices?.[0] ?? '',
    speed: 1,
  };
}

/** Fills in provider-appropriate defaults for any field left blank — mirrors DG-Agent's `normalizeProviderSettings`. */
export function normalizeRealtimeProviderSettings(
  input: RealtimeProviderSettings,
): RealtimeProviderSettings {
  const definition = getRealtimeProviderDefinition(input.providerId);
  const normalized: RealtimeProviderSettings = { ...input };
  normalized.apiKey = normalized.apiKey.trim();
  normalized.model = normalized.model.trim() || definition?.defaultModel || '';
  normalized.baseUrl = normalized.baseUrl.trim().replace(/\/+$/, '');
  normalized.deployment = normalized.deployment.trim();
  normalized.voice = normalized.voice.trim() || definition?.staticVoices?.[0] || '';
  normalized.speed = Number.isFinite(normalized.speed)
    ? Math.min(1.5, Math.max(0.7, normalized.speed))
    : 1;
  return normalized;
}
