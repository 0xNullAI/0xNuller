// Minimal OpenAI-compatible Chat Completions client (non-streaming), used by the in-room AI agent.
// Same idea as DG-Agent's providers-openai-http, trimmed down for DG-Chat's own use.

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

/** Parse a single tool_call: the arguments are a JSON string, and degrade to an empty object
 *  when parsing fails. */
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
      // Models occasionally return invalid JSON; keep empty arguments instead of throwing.
    }
  }
  return {
    id: raw.id ?? crypto.randomUUID(),
    name: raw.function?.name ?? '',
    arguments: args,
  };
}

/** Work out the chat/completions endpoint: the free proxy takes a POST to the root path,
 *  everything else gets /chat/completions appended. */
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
