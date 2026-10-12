import 'fake-indexeddb/auto';
import { createStore, set } from 'idb-keyval';
import { expect, it } from 'vitest';
import type { RuntimeTraceEntry } from '@dg-agent/core';
import { SESSION_TRACE_KEY_PREFIX } from './browser-settings-constants.js';
import { BrowserSessionTraceStore } from './browser-session-trace-store.js';
import { TransientSessionTraceStore } from './transient-session-trace-store.js';

it('round-trips an unknown outcome without changing historical trace entries', async () => {
  const dbName = `agent-trace-test-${crypto.randomUUID()}`;
  const storeName = 'session-traces';
  const sessionId = 'session-1';
  const legacy: RuntimeTraceEntry[] = [
    { id: 'old-result', createdAt: 1, kind: 'tool-result', toolCallId: 'old-1', output: 'done' },
    { id: 'old-denial', createdAt: 2, kind: 'tool-denied', toolCallId: 'old-2' },
  ];
  await set(`${SESSION_TRACE_KEY_PREFIX}${sessionId}`, legacy, createStore(dbName, storeName));

  const writer = new BrowserSessionTraceStore({ dbName, storeName });
  const uncertain = await writer.append(sessionId, {
    kind: 'tool-unknown',
    turnId: 'run-1',
    toolCallId: 'call-1',
    toolName: 'task_plan_save',
    detail: '待核对',
  });
  const reader = new BrowserSessionTraceStore({ dbName, storeName });
  expect(await reader.list(sessionId)).toEqual([...legacy, uncertain]);
  expect(uncertain.kind).toBe('tool-unknown');
  expect(uncertain.kind).not.toBe('tool-result');
  expect(uncertain.kind).not.toBe('tool-failed');
});

it('returns an unknown live trace without persisting conversation details', async () => {
  const store = new TransientSessionTraceStore();
  const entry = await store.append('session-1', {
    kind: 'tool-unknown',
    toolCallId: 'call-1',
    detail: '待核对',
  });
  expect(entry.kind).toBe('tool-unknown');
  expect(await store.list()).toEqual([]);
});
