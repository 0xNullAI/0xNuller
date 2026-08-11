import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState, type SessionSnapshot } from '@dg-agent/core';
import { appendAcceptedUserMessage } from './use-runtime-session-state';

describe('runtime session rendering', () => {
  it('shows an accepted user message immediately and deduplicates the later snapshot', () => {
    const session: SessionSnapshot = {
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      deviceState: createEmptyDeviceState(),
    };
    const message = { id: 'm1', role: 'user' as const, content: '现在显示', createdAt: 2 };
    const next = appendAcceptedUserMessage(session, 's1', message)!;
    expect(next.messages).toEqual([message]);
    expect(appendAcceptedUserMessage(next, 's1', message)).toBe(next);
  });
});
