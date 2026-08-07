// 极简 OpenAI 兼容 Chat Completions 客户端（非流式），供房间内 AI 代理调用。
// 与 DG-Agent 的 providers-openai-http 同源思路，但裁剪为 DG-Chat 自用。

import type { AiConfig } from './ai-config';
import { FREE_PROXY_URL } from './ai-config';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface CallLlmOptions {
  tools?: LlmTool[];
  signal?: AbortSignal;
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/** 解析单条 tool_call：参数为 JSON 字符串，解析失败时退化为空对象。 */
function parseToolCall(raw: {
  id?: string;
  function?: { name?: string; arguments?: string };
}): LlmToolCall {
  let args: Record<string, unknown> = {};
  const rawArgs = raw.function?.arguments;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      // 模型偶尔返回非法 JSON；保留空参数而非抛错。
    }
  }
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: raw.function?.name ?? '',
    arguments: args,
  };
}

/** 计算 chat/completions 端点：免费代理用根路径 POST，其余追加 /chat/completions。 */
function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed === FREE_PROXY_URL) return trimmed;
  return `${trimmed}/chat/completions`;
}

export async function callLlm(
  cfg: AiConfig,
  messages: LlmMessage[],
  opts?: CallLlmOptions,
): Promise<LlmResult> {
  const tools = opts?.tools;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey.trim()) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const body = {
    model: cfg.model,
    messages,
    max_tokens: opts?.maxTokens ?? 1024,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
  };

  let res: Response;
  try {
    res = await fetch(resolveEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new Error(`LLM 请求失败：${(err as Error)?.message ?? '网络错误'}`, { cause: err });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败 (${res.status})${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  return {
    text: message?.content ?? '',
    toolCalls: (message?.tool_calls ?? []).map(parseToolCall),
  };
}
