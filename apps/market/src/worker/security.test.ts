import { describe, expect, it, vi } from 'vitest';
import worker, { recordVerifiedClaims, requireMarketAdmin } from './index';
import { hashSourceIp } from './security';

describe('Market account ownership', () => {
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
    const rows = ['solo', 'party'].map((id, index) => ({
      id,
      type: index === 0 ? 'scenario' : 'multi-scene',
      name: id,
      description: null,
      author: null,
      icon: null,
      tags: null,
      content: index === 0 ? '{"prompt":"mist"}' : '{"setting":"mist","roles":[{"name":"guide"}]}',
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
    expect(sql).toContain('type IN (?, ?)');
    expect(sql).toContain('hidden = 1');
    expect(binds).toEqual(['scenario', 'multi-scene', '%mist%', '%mist%', '%mist%', 2, 4]);
  });

  it('does not expose the removed report endpoint', async () => {
    const response = await worker.fetch(
      new Request('https://market.test/api/items/item-1/report', { method: 'POST' }),
      { DB: {}, AUTH: {} } as never,
    );
    expect(response.status).toBe(404);
  });
});
