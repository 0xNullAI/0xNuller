// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { Env } from './index';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { AccountRegistryDO } from './account-registry-do';
it('keeps a permanent account tombstone, paginates pending rooms, and acknowledges legacy hints', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...args: unknown[]) => ({
      toArray: () => db.prepare(query).all(...(args as never[])),
    }),
  };
  // Execute eager mutations just like SqlStorage (toArray is optional for writes).
  sql.exec = (query, ...args) => {
    const rows = db.prepare(query).all(...(args as never[]));
    return { toArray: () => rows };
  };
  const registry = new AccountRegistryDO(
    { storage: { sql } } as unknown as DurableObjectState,
    {} as Env,
  );
  try {
    for (let i = 0; i < 120; i++)
      await registry.registerGroup('alice', `room-${String(i).padStart(3, '0')}`);
    const first = await registry.tombstone('alice', 'alice:1234');
    expect(first.rooms).toHaveLength(100);
    expect(first.legacyCoverage).toBe('unknown');
    expect((await registry.tombstone('alice', 'alice:1234', first.nextCursor!)).rooms).toHaveLength(
      20,
    );
    expect(await registry.registerGroup('alice', 'new-room')).toEqual({
      allowed: false,
      deletionId: 'alice:1234',
    });
    expect(await registry.registerGroup('alice', 'legacy-room', true)).toEqual({
      allowed: false,
      deletionId: 'alice:1234',
    });
    expect((await registry.tombstone('alice', 'alice:1234')).rooms).toContain('legacy-room');
    await registry.acknowledge('alice', 'alice:1234', 'legacy-room');
    await registry.acknowledge('alice', 'alice:1234', 'unindexed-hint');
    for (let i = 0; i < 120; i++)
      await registry.acknowledge('alice', 'alice:1234', `room-${String(i).padStart(3, '0')}`);
    expect((await registry.tombstone('alice', 'alice:1234')).rooms).toEqual([]);
    await registry.registerGroup('alice', 'legacy-room', true);
    expect((await registry.tombstone('alice', 'alice:1234')).rooms).toEqual([]);
    await expect(registry.tombstone('alice', 'other-job')).rejects.toThrow('job mismatch');
    await expect(registry.registerGroup('bob', 'room')).rejects.toThrow('account mismatch');
  } finally {
    db.close();
  }
});
