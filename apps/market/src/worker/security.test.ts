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
      reports: 2,
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
      new Request('https://market.test/api/items/admin?status=reported'),
      env as never,
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: 'item-1', reports: 2, hidden: false }],
      nextOffset: null,
    });

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
});
