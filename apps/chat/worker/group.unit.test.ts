import { describe, expect, it } from 'vitest';
import { canAdministerGroup, hashOwnerKey, resolveGroupOwner } from './group';

describe('group owner account', () => {
  it('administers only through the owner account once one is bound', async () => {
    const ownerKeyHash = await hashOwnerKey('g', 'legacy-key');
    const base = { code: 'g', ownerAccountId: 'alice', ownerKeyHash, presentedKey: 'legacy-key' };
    expect(await canAdministerGroup({ ...base, senderAccountId: 'alice' })).toBe(true);
    // A leaked browser key no longer grants anything after the account binding.
    expect(await canAdministerGroup({ ...base, senderAccountId: 'bob' })).toBe(false);
    expect(await canAdministerGroup({ ...base, senderAccountId: undefined })).toBe(false);
  });

  it('accepts a legacy owner key only until the group is bound, and never the host', async () => {
    const ownerKeyHash = await hashOwnerKey('g', 'legacy-key');
    const base = { code: 'g', ownerAccountId: null, senderAccountId: 'bob' };
    expect(await canAdministerGroup({ ...base, ownerKeyHash, presentedKey: 'legacy-key' })).toBe(
      true,
    );
    expect(await canAdministerGroup({ ...base, ownerKeyHash, presentedKey: 'wrong' })).toBe(false);
    expect(await canAdministerGroup({ ...base, ownerKeyHash: null, presentedKey: undefined })).toBe(
      false,
    );
  });

  it.each([
    ['new group claimed by its creator', null, false, true, undefined, 'alice'],
    ['legacy ownerless group: first signed-in member', null, false, false, undefined, 'alice'],
    ['legacy keyed group: proven key holder', null, true, false, 'legacy-key', 'alice'],
    ['legacy keyed group: member without the key waits', null, true, false, undefined, null],
    ['legacy keyed group: a claim cannot take it', null, true, true, undefined, null],
    ['already bound group never moves', 'carol', false, false, undefined, null],
  ] as const)('%s', async (_label, ownerAccountId, keyed, claim, presentedKey, expected) => {
    const ownerKeyHash = keyed ? await hashOwnerKey('g', 'legacy-key') : null;
    expect(
      await resolveGroupOwner({
        code: 'g',
        ownerAccountId,
        ownerKeyHash,
        senderAccountId: 'alice',
        claim,
        presentedKey,
      }),
    ).toBe(expected);
  });

  it('never binds a group to a signed-out connection', async () => {
    expect(
      await resolveGroupOwner({
        code: 'g',
        ownerAccountId: null,
        ownerKeyHash: null,
        senderAccountId: undefined,
        claim: true,
        presentedKey: undefined,
      }),
    ).toBeNull();
  });
});
