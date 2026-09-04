// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { appendModelLogEvent, clearModelLogs } from './model-log-store.js';

describe('model log image redaction', () => {
  beforeEach(() => clearModelLogs());

  it('never persists nested image bytes from requests or responses', () => {
    const started = appendModelLogEvent([], {
      type: 'llm-turn-start',
      sessionId: 'session',
      iteration: 0,
      instructions: '',
      messages: [{ role: 'user', content: 'look' }],
      toolNames: [],
    });
    const completed = appendModelLogEvent(started, {
      type: 'llm-turn-complete',
      sessionId: 'session',
      iteration: 0,
      assistantMessage: 'ok',
      toolCalls: [],
      rawRequest: { content: [{ type: 'image', data: 'camera-secret' }] },
      rawResponse: { url: 'data:image/jpeg;base64,camera-secret' },
    });

    const serialized = JSON.stringify(completed);
    expect(serialized).not.toContain('camera-secret');
    expect(serialized).toContain('[REDACTED_IMAGE]');
  });
});

it('bounds retained history and truncates oversized diagnostic payloads', () => {
  let turns: ReturnType<typeof appendModelLogEvent> = [];
  for (let iteration = 0; iteration < 150; iteration++) {
    turns = appendModelLogEvent(turns, {
      type: 'llm-turn-start',
      sessionId: 'bounded',
      iteration,
      instructions: 'x'.repeat(100_000),
      messages: [],
      toolNames: [],
    });
  }
  expect(turns.length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(turns).length).toBeLessThan(260_000);
  expect(turns.at(-1)?.iteration).toBe(149);
  expect(turns.at(-1)?.request?.rawRequest).toBe('[TRUNCATED]');
});
