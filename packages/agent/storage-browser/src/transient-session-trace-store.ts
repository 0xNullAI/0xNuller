import type { RuntimeTraceEntry, SessionTraceStore } from '@dg-agent/core';

/** Live trace events are rendered by the mounted UI; never retain payloads across account/session changes. */
export class TransientSessionTraceStore implements SessionTraceStore {
  async list(): Promise<RuntimeTraceEntry[]> {
    return [];
  }
  async append(
    _sessionId: string,
    entry: Omit<RuntimeTraceEntry, 'id' | 'createdAt'>,
  ): Promise<RuntimeTraceEntry> {
    return { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
  }
  async clear(): Promise<void> {}
}
