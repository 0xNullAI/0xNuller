import { describe, expect, it, vi } from 'vitest';
import worker, { recordVerifiedClaims, requireMarketAdmin } from './index';
import { hashSourceIp } from './security';
import { listItems, rowToItem } from './db';

describe('Market account ownership', () => {
  it('keeps imported source JSON out of list cards while allowing a complete detail', () => {
    const row = {
      id: 'card-1',
      type: 'scenario',
      name: '书屋',
      description: null,
      author: null,
      icon: null,
      tags: null,
      content: JSON.stringify({
        prompt: '人物设定',
        sourceArchive: {
          format: 'ccv2',
          raw: {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: '书屋', extensions: { future: true } },
          },
        },
      }),
      downloads: 0,
      views: 0,
      hidden: 0,
      created_at: 1,
      revision: 1,
    };
    expect(rowToItem(row).content).not.toHaveProperty('sourceArchive');
    expect(rowToItem(row, true).content).toHaveProperty('sourceArchive');
  });
  it('角色筛选只读取未隐藏的原生角色卡，旧场景列表保持兼容', async () => {
    const statements: string[] = [];
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    } as unknown as D1Database;
    await listItems(db, { type: 'scenario', character: true, sort: 'hot', limit: 50, offset: 0 });
    expect(statements[0]).toContain('hidden = 0');
    expect(statements[0]).toContain("json_extract(content, '$.characterCard.schemaVersion') = 1");
    await listItems(db, { type: 'scenario', sort: 'new', limit: 50, offset: 0 });
    expect(statements[1]).not.toContain('characterCard');
  });

  it('maps every public engagement sort to a concrete server-side order', async () => {
    const statements: string[] = [];
    const db = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
        };
      },
    } as unknown as D1Database;

    for (const sort of ['new', 'hot', 'views', 'downloads'] as const) {
      await listItems(db, { sort, limit: 10, offset: 0 });
    }

    expect(statements[0]).toContain('ORDER BY created_at DESC');
    expect(statements[1]).toContain('ORDER BY (views + downloads * 4) DESC, created_at DESC');
    expect(statements[2]).toContain('ORDER BY views DESC, created_at DESC');
    expect(statements[3]).toContain('ORDER BY downloads DESC, created_at DESC');
  });

  it('hashes a source without retaining the address', async () => {
    const ip = await hashSourceIp('203.0.113.7', 'ip-pepper');
    expect(ip).toHaveLength(32);
    expect(ip).not.toContain('203.0.113.7');
  });

  it('requires a current account for every upload', async () => {
    const env = {
      AUTH: {
        claimMarketItems: async () => 'unauthorized' as const,
      },
    } satisfies Parameters<typeof recordVerifiedClaims>[0];

    await expect(
      recordVerifiedClaims(env, new Request('https://market.test/api/items'), ['anonymous']),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      recordVerifiedClaims(
        env,
        new Request('https://market.test/api/items', {
          headers: { Authorization: 'Bearer expired' },
        }),
        ['authenticated'],
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('admits only account administrators to moderation routes', async () => {
    const request = new Request('https://market.test/api/items/admin', {
      headers: { Authorization: 'Bearer session' },
    });
    const withAccess = (access: 'admin' | 'user' | 'unauthorized') => ({
      AUTH: { marketAccountAccess: async () => access },
    });

    await expect(requireMarketAdmin(request, withAccess('unauthorized'))).rejects.toMatchObject({
      status: 401,
    });
    await expect(requireMarketAdmin(request, withAccess('user'))).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireMarketAdmin(request, withAccess('admin'))).resolves.toBeUndefined();
  });

  it('lets an owner update the scene script but rejects another account', async () => {
    const row = {
      id: 'scene-1',
      type: 'scenario',
      name: '旧剧本',
      description: null,
      author: 'alice',
      icon: '🎭',
      tags: null,
      content: '{"prompt":"旧内容"}',
      downloads: 0,
      views: 0,
      hidden: 0,
      created_at: 1,
    };
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          first: vi.fn(async () => row),
          run: vi.fn(async () => {
            updates.push({ sql, values });
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    };
    const patch = new Request('https://market.test/api/items/scene-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alice' },
      body: JSON.stringify({ name: '新剧本', content: { prompt: '新内容' } }),
    });

    const ownerResponse = await worker.fetch(patch, {
      DB: db,
      AUTH: { marketItemAccess: async () => 'owner' as const },
    } as never);

    expect(ownerResponse.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain('name = ?');
    expect(updates[0]!.sql).toContain('content = ?');
    expect(updates[0]!.values).toEqual(['新剧本', '{"prompt":"新内容","kind":"scene"}', 'scene-1']);

    const otherResponse = await worker.fetch(
      new Request('https://market.test/api/items/scene-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bob' },
        body: JSON.stringify({ content: { prompt: '越权内容' } }),
      }),
      {
        DB: db,
        AUTH: { marketItemAccess: async () => 'user' as const },
      } as never,
    );
    expect(otherResponse.status).toBe(403);
    expect(updates).toHaveLength(1);
  });

  it('rejects a stale character edit without writing over the current revision', async () => {
    const row = {
      id: 'character-1',
      type: 'scenario',
      name: '角色',
      description: null,
      author: null,
      icon: '🎭',
      tags: null,
      content: '{"prompt":"当前设定","characterCard":{"schemaVersion":1}}',
      downloads: 0,
      views: 0,
      hidden: 0,
      created_at: 1,
      revision: 2,
    };
    const writes: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...binds: unknown[]) => ({
          first: vi.fn(async () => row),
          run: vi.fn(async () => {
            writes.push({ sql, binds });
            return { meta: { changes: 0 } };
          }),
        })),
      })),
    };
    const response = await worker.fetch(
      new Request('https://market.test/api/items/character-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ expectedRevision: 1, name: '过期修改' }),
      }),
      { DB: db, AUTH: { marketItemAccess: async () => 'owner' as const } } as never,
    );
    expect(response.status).toBe(409);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain('AND revision = ?');
    expect(writes[0]?.binds).toEqual(['过期修改', 'character-1', 1]);
  });

  it('keeps a published character marker when a legacy client edits only its prompt', async () => {
    const card = {
      schemaVersion: 1,
      description: '',
      personality: '温柔',
      greeting: '',
      exampleDialogue: '',
      tags: [],
      creator: '',
      license: '',
    };
    const row = {
      id: 'character-1',
      type: 'scenario',
      name: '小岚',
      description: null,
      author: null,
      icon: null,
      tags: null,
      content: JSON.stringify({ prompt: '旧', characterCard: card }),
      downloads: 0,
      views: 0,
      hidden: 0,
      created_at: 1,
      revision: 1,
    };
    let written = '';
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn((...values: unknown[]) => ({
          first: vi.fn(async () => row),
          run: vi.fn(async () => {
            written = String(values[0]);
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    };
    const response = await worker.fetch(
      new Request('https://market.test/api/items/character-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ content: { prompt: '新' } }),
      }),
      { DB: db, AUTH: { marketItemAccess: async () => 'owner' as const } } as never,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(written)).toEqual({ prompt: '新', kind: 'character', characterCard: card });
  });

  it('keeps a published card kind stable across explicit and legacy edits', async () => {
    const card = {
      schemaVersion: 1,
      description: '',
      personality: '温柔',
      greeting: '',
      exampleDialogue: '',
      tags: [],
      creator: '',
      license: '',
    };
    const rows = {
      scene: {
        id: 'scene',
        type: 'scenario',
        content: '{"prompt":"森林"}',
      },
      character: {
        id: 'character',
        type: 'scenario',
        content: JSON.stringify({ prompt: '朋友', characterCard: card }),
      },
    };
    const writes = vi.fn(async () => ({ meta: { changes: 1 } }));
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn((id: keyof typeof rows) => ({
          first: vi.fn(async () => rows[id]),
          run: writes,
        })),
      })),
    };
    const patch = (id: keyof typeof rows, content: unknown) =>
      worker.fetch(
        new Request(`https://market.test/api/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content }),
        }),
        { DB: db, AUTH: { marketItemAccess: async () => 'owner' } } as never,
      );
    expect(
      (await patch('scene', { kind: 'character', prompt: '森林', characterCard: card })).status,
    ).toBe(409);
    expect((await patch('character', { kind: 'scene', prompt: '朋友' })).status).toBe(409);
    expect((await patch('scene', { prompt: '森林', characterCard: card })).status).toBe(400);
    expect(writes).not.toHaveBeenCalled();
  });

  it('lets an owner delete a scene but rejects another account', async () => {
    const deletes: string[] = [];
    const db = {
      prepare: vi.fn((_sql: string) => ({
        bind: vi.fn((id: string) => ({
          run: vi.fn(async () => {
            deletes.push(id);
            return { meta: { changes: 1 } };
          }),
        })),
      })),
    };
    const remove = (access: 'owner' | 'user') =>
      worker.fetch(
        new Request('https://market.test/api/items/scene-1', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer session' },
        }),
        { DB: db, AUTH: { marketItemAccess: async () => access } } as never,
      );

    expect((await remove('user')).status).toBe(403);
    expect(deletes).toEqual([]);
    expect((await remove('owner')).status).toBe(200);
    expect(deletes).toEqual(['scene-1']);
  });

  it('serves the moderation queue and visibility action through account roles', async () => {
    const row = {
      id: 'item-1',
      type: 'waveform',
      name: '测试波形',
      description: null,
      author: 'alice',
      icon: null,
      tags: null,
      content: '{"frames":[[10,0]]}',
      downloads: 0,
      views: 0,
      hidden: 0,
      created_at: 1,
    };
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const all = vi.fn(async () => ({ results: [row] }));
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all, run })),
      })),
    };
    const env = {
      DB: db,
      AUTH: { marketAccountAccess: async () => 'admin' as const },
    };

    const list = await worker.fetch(
      new Request('https://market.test/api/items/admin?status=all'),
      env as never,
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody).toMatchObject({
      items: [{ id: 'item-1', hidden: false }],
      nextOffset: null,
    });
    expect(listBody.items[0]).not.toHaveProperty('reports');

    const hide = await worker.fetch(
      new Request('https://market.test/api/items/item-1/moderation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      }),
      env as never,
    );
    expect(hide.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });

  it('returns the next server-side admin page for a validated category filter', async () => {
    const rows = ['solo', 'another-scene'].map((id, index) => ({
      id,
      type: 'scenario',
      name: id,
      description: null,
      author: null,
      icon: null,
      tags: null,
      content: '{"prompt":"mist"}',
      downloads: 0,
      views: 0,
      hidden: 1,
      created_at: 2 - index,
    }));
    let sql = '';
    let binds: unknown[] = [];
    const env = {
      DB: {
        prepare: vi.fn((statement: string) => {
          sql = statement;
          return {
            bind: vi.fn((...values: unknown[]) => {
              binds = values;
              return { all: vi.fn(async () => ({ results: rows })) };
            }),
          };
        }),
      },
      AUTH: { marketAccountAccess: async () => 'admin' as const },
    };

    const response = await worker.fetch(
      new Request(
        'https://market.test/api/items/admin?type=scenario&status=hidden&q=mist&limit=2&offset=4',
      ),
      env as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ nextOffset: 6 });
    expect(sql).toContain('type = ?');
    expect(sql).not.toContain('multi-scene');
    expect(sql).toContain('hidden = 1');
    expect(binds).toEqual(['scenario', '%mist%', '%mist%', '%mist%', 2, 4]);
  });

  it('does not expose the removed report endpoint', async () => {
    const response = await worker.fetch(
      new Request('https://market.test/api/items/item-1/report', { method: 'POST' }),
      { DB: {}, AUTH: {} } as never,
    );
    expect(response.status).toBe(404);
  });
});
