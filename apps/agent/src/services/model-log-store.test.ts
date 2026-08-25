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
