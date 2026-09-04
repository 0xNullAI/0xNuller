import type { RuntimeEvent, ToolCall } from '@dg-agent/core';
import { redactModelData } from '@dg-agent/runtime';

const STORAGE_KEY = 'dg-agent.model-logs';

export interface ModelLogTurn {
  id: string;
  sessionId: string;
  iteration: number;
  startedAt: number;
  completedAt?: number;
  request?: {
    instructions: string;
    messages: Array<{ role: string; content: string; toolCallCount?: number }>;
    toolNames: string[];
    rawRequest?: unknown;
  };
  response?: {
    assistantMessage: string;
    toolCalls: ToolCall[];
    rawResponse?: unknown;
  };
}

function turnKey(sessionId: string, iteration: number): string {
  return `${sessionId}::${iteration}`;
}

export const MODEL_LOG_LIMIT = 100;
const MAX_LOG_CHARS = 256_000;
const MAX_TURN_CHARS = 16_000;

export function boundModelLogs(turns: ModelLogTurn[]): ModelLogTurn[] {
  const result: ModelLogTurn[] = [];
  let size = 0;
  for (const turn of turns.slice(-MODEL_LOG_LIMIT).reverse()) {
    const length = JSON.stringify(turn).length;
    if (size + length > MAX_LOG_CHARS) break;
    result.unshift(turn);
    size += length;
  }
  return result;
}

function boundTurn(turn: ModelLogTurn): ModelLogTurn {
  const serialized = JSON.stringify(turn);
  if (serialized.length <= MAX_TURN_CHARS) return turn;
  // Metadata stays usable. Oversized diagnostic payloads never consume unbounded memory.
  return {
    ...turn,
    request: turn.request
      ? {
          instructions: turn.request.instructions.slice(0, 2048),
          messages: turn.request.messages
            .slice(-8)
            .map((message) => ({ role: message.role, content: message.content.slice(0, 512) })),
          toolNames: turn.request.toolNames.slice(0, 32),
          rawRequest: '[TRUNCATED]',
        }
      : undefined,
    response: turn.response
      ? {
          assistantMessage: turn.response.assistantMessage.slice(0, 2048),
          toolCalls: [],
          rawResponse: '[TRUNCATED]',
        }
      : undefined,
  };
}

/** Migration happens only when diagnostics are enabled, never on ordinary startup. */
export function readLegacyModelLogs(): ModelLogTurn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return boundModelLogs(
      value
        .filter(
          (item): item is ModelLogTurn =>
            !!item &&
            typeof item.id === 'string' &&
            typeof item.sessionId === 'string' &&
            typeof item.startedAt === 'number',
        )
        .map(boundTurn),
    );
  } catch {
    return [];
  }
}

export function clearModelLogs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* IndexedDB remains the owner. */
  }
}

export function appendModelLogEvent(current: ModelLogTurn[], event: RuntimeEvent): ModelLogTurn[] {
  if (event.type !== 'llm-turn-start' && event.type !== 'llm-turn-complete') {
    return current;
  }

  const key = turnKey(event.sessionId, event.iteration);
  const existingIndex = current.findIndex(
    (t) => turnKey(t.sessionId, t.iteration) === key && t.completedAt === undefined,
  );

  if (event.type === 'llm-turn-start') {
    const turn: ModelLogTurn = {
      id: `${key}::${Date.now()}`,
      sessionId: event.sessionId,
      iteration: event.iteration,
      startedAt: Date.now(),
      request: {
        instructions: event.instructions,
        messages: event.messages,
        toolNames: event.toolNames,
      },
    };
    const next =
      existingIndex >= 0
        ? current.map((t, i) => (i === existingIndex ? { ...t, ...turn, id: t.id } : t))
        : [...current, turn];
    return boundModelLogs(
      next.map((record) =>
        record === next[next.length - 1] || record.id === current[existingIndex]?.id
          ? boundTurn(record)
          : record,
      ),
    );
  }

  if (existingIndex < 0) {
    const orphan: ModelLogTurn = {
      id: `${key}::${Date.now()}`,
      sessionId: event.sessionId,
      iteration: event.iteration,
      startedAt: Date.now(),
      completedAt: Date.now(),
      response: {
        assistantMessage: event.assistantMessage,
        toolCalls: event.toolCalls,
        rawResponse: redactModelData(event.rawResponse),
      },
    };
    const next = [...current, orphan];
    return boundModelLogs(
      next.map((record) =>
        record === next[next.length - 1] || record.id === current[existingIndex]?.id
          ? boundTurn(record)
          : record,
      ),
    );
  }

  const next = current.map((t, i) =>
    i === existingIndex
      ? {
          ...t,
          completedAt: Date.now(),
          request: t.request
            ? { ...t.request, rawRequest: redactModelData(event.rawRequest) }
            : {
                instructions: '',
                messages: [],
                toolNames: [],
                rawRequest: redactModelData(event.rawRequest),
              },
          response: {
            assistantMessage: event.assistantMessage,
            toolCalls: event.toolCalls,
            rawResponse: redactModelData(event.rawResponse),
          },
        }
      : t,
  );
  return boundModelLogs(
    next.map((record, index) => (index === existingIndex ? boundTurn(record) : record)),
  );
}
