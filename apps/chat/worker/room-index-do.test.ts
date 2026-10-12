// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { Env } from './index';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const { RoomIndexDO } = await import('./room-index-do');

it('lists observed and hinted rooms with stable pages; tombstones survive later observations', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  };
  const index = new RoomIndexDO({ storage: { sql } } as unknown as DurableObjectState, {} as Env);
  try {
    for (let i = 0; i < 101; i++)
      await index.register(`room-${String(i).padStart(3, '0')}`, 'group');
    await index.register('dm:legacy', 'dm', 'historical-hint');
    const first = await index.list();
    expect(first.rooms).toHaveLength(100);
    expect(first.cursor).toBe('room-098');
    const second = await index.list(first.cursor!);
    expect(second.rooms.map((row) => row.code)).toEqual(['room-099', 'room-100']);
    expect(second.cursor).toBeNull();
    await index.tombstone('room-100', 'group', 'closed');
    await index.register('room-100', 'group');
    const closed = (await index.list(first.cursor!)).rooms[1]!;
    expect(closed.deletion_reason).toBe('closed');
    expect(closed.deleted_at).not.toBeNull();
    expect((await index.list()).rooms[0]).toMatchObject({
      code: 'dm:legacy',
      source: 'historical-hint',
    });
    await index.tombstoneAccount('alice', 'job-1');
    await index.tombstoneAccount('alice', 'job-1');
    expect((await index.listAccountTombstones()).accounts).toMatchObject([
      { account_id: 'alice', deletion_id: 'job-1' },
    ]);
    await expect(index.tombstoneAccount('alice', 'job-2')).rejects.toThrow('mismatch');
    await expect(index.register('dm:not-valid!', 'dm')).rejects.toThrow('invalid room');
  } finally {
    db.close();
  }
});
