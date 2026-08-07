import type { LlmConversationItem } from '@dg-agent/core';
import type { SessionSnapshot, ToolDefinition, ToolCall } from '@dg-agent/core';
import { repairJson } from './repair-json.js';
import { strictify, widenWithNull } from './schema-utils.js';

export function toChatMessages(
  conversation: LlmConversationItem[],
  instructions: string,
  options: { includeReasoningContent: boolean },
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (instructions.trim()) {
    messages.push({
      role: 'system',
      content: instructions,
    });
  }

  for (const item of conversation) {
    if (item.kind === 'message') {
      const message: Record<string, unknown> = {
        role: item.role,
        content: item.content,
      };
      if (item.role === 'assistant') {
        if (item.reasoningContent && options.includeReasoningContent) {
          message.reasoning_content = item.reasoningContent;
        }
        if (item.toolCalls?.length) {
          message.tool_calls = item.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: serializeToolCallArgs(toolCall.args),
            },
          }));
        }
      }
      messages.push(message);
      continue;
    }

    if (item.kind === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.callId,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.argumentsJson,
            },
          },
        ],
      });
      continue;
    }

    messages.push({
      role: 'tool',
      tool_call_id: item.callId,
      content: item.output,
    });
  }

  return messages;
}

export function toResponsesInput(
  conversation: LlmConversationItem[],
): Array<Record<string, unknown>> {
  return conversation.flatMap((item) => {
    if (item.kind === 'message') {
      const items: Array<Record<string, unknown>> = [
        {
          role: item.role,
          content: item.content,
        },
      ];

      if (item.role === 'assistant' && item.toolCalls?.length) {
        items.push(
          ...item.toolCalls.map((toolCall) => ({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: serializeToolCallArgs(toolCall.args),
          })),
        );
      }

      return items;
    }

    if (item.kind === 'function_call') {
      return [
        {
          type: 'function_call',
          call_id: item.callId,
          name: item.name,
          arguments: item.argumentsJson,
        },
      ];
    }

    return [
      {
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output,
      },
    ];
  });
}

export function toResponsesTool(tool: ToolDefinition, useStrict: boolean): Record<string, unknown> {
  const parameters = useStrict ? strictify(tool.parameters) : tool.parameters;
  const base: Record<string, unknown> = {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters,
  };

  if (useStrict) {
    base.strict = true;
  }

  return base;
}

export function toChatTool(tool: ToolDefinition, useStrict: boolean): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: useStrict ? strictify(tool.parameters) : tool.parameters,
    },
  };
}

export function normalizeContent(content: string | null | undefined): string {
  return content ?? '';
}

export function normalizeOptionalContent(content: string | null | undefined): string | undefined {
  return content ?? undefined;
}

function serializeToolCallArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

export function toToolCall(toolCall: {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}): ToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    args: parseArguments(toolCall.function.arguments),
  };
}

export function parseArguments(raw: string): Record<string, unknown> {
  const source = raw || '{}';
  try {
    return JSON.parse(source) as Record<string, unknown>;
  } catch {
    // fall through to the light repair pass
  }

  try {
    return JSON.parse(repairJson(source)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function toConversationItems(session: SessionSnapshot): LlmConversationItem[] {
  return session.messages.map((item) => ({
    kind: 'message',
    role: item.role,
    content: item.content,
    reasoningContent: item.reasoningContent,
    toolCalls: item.toolCalls,
  }));
}

// Re-export for consumers that may import from this module
export { widenWithNull, strictify };
