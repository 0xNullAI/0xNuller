import { describe, expect, it } from 'vitest';
import { recordVerifiedClaims } from './index';
import { hashCurrentEditKey, hashLegacyEditKey, hashSourceIp, secretEqual } from './security';

describe('Market security domains', () => {
  it('does not couple admin, edit-key and source-IP hashes', async () => {
    const [legacy, current, ip] = await Promise.all([
      hashLegacyEditKey('human-key', 'admin-secret'),
      hashCurrentEditKey('human-key', 'edit-pepper'),
      hashSourceIp('203.0.113.7', 'ip-pepper'),
    ]);
    expect(current).not.toBe(legacy);
    expect(ip).not.toBe(current.slice(0, 32));
  });

  it('compares both matching and differently-sized secrets', async () => {
    await expect(secretEqual('same', 'same')).resolves.toBe(true);
    await expect(secretEqual('same', 'different-and-longer')).resolves.toBe(false);
  });

  it('allows truly anonymous uploads but rejects stale account credentials', async () => {
    const env = {
      AUTH: {
        claimMarketItems: async () => 'unauthorized' as const,
      },
    } as unknown as Parameters<typeof recordVerifiedClaims>[0];

    await expect(
      recordVerifiedClaims(env, new Request('https://market.test/api/items'), ['anonymous']),
    ).resolves.toBe('anonymous');
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
