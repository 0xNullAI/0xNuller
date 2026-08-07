import type { LlmConversationItem } from '@dg-agent/core';
import {
  createMessage,
  type ConversationMessage,
  type SessionSnapshot,
  type ToolCall,
} from '@dg-agent/core';

export function normalizeSessionHistory(session: SessionSnapshot): boolean {
  let changed = false;
  const normalizedMessages: ConversationMessage[] = [];

  for (const message of session.messages) {
    if (message.role === 'system' || isInternalSyntheticMessage(message.content)) {
      changed = true;
      continue;
    }

    if (message.role === 'assistant') {
      const previousComparable = findPreviousComparableMessage(normalizedMessages);
      if (
        previousComparable?.role === 'assistant' &&
        areAssistantMessagesEquivalent(previousComparable, message)
      ) {
        changed = true;
        continue;
      }
    }

    normalizedMessages.push(message);
  }

  if (!changed) {
    return false;
  }

  session.messages = normalizedMessages;
  session.updatedAt = Date.now();
  return true;
}

function findPreviousComparableMessage(
  messages: ConversationMessage[],
): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current) continue;
    return current;
  }

  return undefined;
}

export function appendAssistantMessage(
  session: SessionSnapshot,
  input: {
    content: string;
    reasoningContent?: string;
    toolCalls?: ToolCall[];
  },
  turnStartIndex: number,
): ConversationMessage {
  const normalized = buildAssistantMessageSignature(input);
  const existing = session.messages.slice(turnStartIndex + 1).find(
    (message) =>
      message.role === 'assistant' &&
      buildAssistantMessageSignature({
        content: message.content,
        reasoningContent: message.reasoningContent,
        toolCalls: message.toolCalls,
      }) === normalized,
  );
  if (existing) {
    return existing;
  }

  const message = createMessage('assistant', input.content, Date.now(), {
    reasoningContent: input.reasoningContent,
    toolCalls: input.toolCalls,
  });
  session.messages.push(message);
  return message;
}

function areAssistantMessagesEquivalent(
  left: ConversationMessage,
  right: ConversationMessage,
): boolean {
  return (
    buildAssistantMessageSignature({
      content: left.content,
      reasoningContent: left.reasoningContent,
      toolCalls: left.toolCalls,
    }) ===
    buildAssistantMessageSignature({
      content: right.content,
      reasoningContent: right.reasoningContent,
      toolCalls: right.toolCalls,
    })
  );
}

export function buildAssistantMessageSignature(input: {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
}): string {
  // Dedup by visible text and reasoning only. Tool calls are intentionally
  // excluded so an iteration that emitted "X" with a tool call dedupes against
  // a later final reply that emits "X" without tool calls.
  return JSON.stringify({
    content: input.content.trim(),
    reasoningContent: input.reasoningContent?.trim() ?? '',
  });
}

export function appendSkippedToolOutputs(
  target: LlmConversationItem[],
  toolCalls: ToolCall[],
  reason: string,
): void {
  for (const toolCall of toolCalls) {
    target.push({
      kind: 'function_call_output',
      callId: toolCall.id,
      output: JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-denied',
          toolName: toolCall.name,
        },
      }),
    });
  }
}

function isInternalSyntheticMessage(content: string): boolean {
  return (
    content.startsWith('[Timer due]') ||
    content.startsWith('[内部提醒]') ||
    content.startsWith('[系统事件：定时器到期]')
  );
}
