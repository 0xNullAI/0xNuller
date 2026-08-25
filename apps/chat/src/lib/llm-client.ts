import type { AiConfig } from './ai-config';
import { createBrowserLlmClient } from '@dg-agent/agent-browser/llm';
import type {
  LlmConversationItem,
  SessionSnapshot,
  ToolCall,
  ToolDefinition,
} from '@dg-agent/core';
import { createEmptyDeviceState } from '@dg-agent/core';
import type { ProviderId } from '@0xnullai/llm-providers';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  toolCalls?: LlmToolCall[];
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

export async function callLlm(
  cfg: AiConfig,
  messages: LlmMessage[],
  opts?: CallLlmOptions,
): Promise<LlmResult> {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = toConversation(messages);
  const client = createBrowserLlmClient({
    provider: {
      providerId: cfg.providerId as ProviderId,
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      endpoint: cfg.endpoint,
      useStrict: cfg.useStrict,
    },
  });
  const result = await client.runTurn({
    session: EMPTY_SESSION,
    message: '',
    context: {
      sessionId: EMPTY_SESSION.id,
      sourceType: 'web',
      traceId: 'chat-room-agent',
    },
    instructions,
    tools: (opts?.tools ?? []).map(toToolDefinition),
    abortSignal: opts?.signal,
    maxOutputTokens: opts?.maxTokens ?? 1024,
    conversation,
  });
  return {
    text: result.assistantMessage,
    toolCalls: (result.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.args,
    })),
  };
}

const EMPTY_SESSION: SessionSnapshot = {
  id: 'chat-room-agent',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  deviceState: createEmptyDeviceState(),
};

function toToolDefinition(tool: LlmTool): ToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as Record<string, unknown>,
  };
}

function toConversation(messages: LlmMessage[]): LlmConversationItem[] {
  return messages.flatMap((message): LlmConversationItem[] => {
    if (message.role === 'system') return [];
    if (message.role === 'tool') {
      return message.tool_call_id
        ? [{ kind: 'function_call_output', callId: message.tool_call_id, output: message.content }]
        : [];
    }
    const toolCalls: ToolCall[] | undefined = message.toolCalls?.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.arguments,
    }));
    return [
      {
        kind: 'message',
        role: message.role,
        content: message.content,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
      },
    ];
  });
}
