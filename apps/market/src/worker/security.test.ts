import { describe, expect, it } from 'vitest';
import { recordVerifiedClaims } from './index';
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
});
