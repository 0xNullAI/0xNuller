// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  initializeGroupMembership,
  groupMembership,
  joinGroupMembership,
  leaveGroupMembership,
  moderateGroupMembership,
  activeGroupMember,
} from './group-membership';
it('joins only explicit verified identities and versions leave/remove/ban/restore without resurrection', () => {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  try {
    initializeGroupMembership(sql);
    expect(groupMembership(sql, 'old-anonymous')).toBeNull();
    const first = joinGroupMembership(sql, 'alice', 'Alice', 1)!;
    expect(first.version).toBe(1);
    expect(joinGroupMembership(sql, 'alice', 'New name', 2)!.version).toBe(1);
    expect(leaveGroupMembership(sql, 'alice', first.version, 3)).toBe(true);
    expect(activeGroupMember(sql, 'alice', 1)).toBeNull();
    const next = joinGroupMembership(sql, 'alice', 'Alice', 4)!;
    expect(next.version).toBe(3);
    expect(leaveGroupMembership(sql, 'alice', 1, 5)).toBe(false);
    expect(activeGroupMember(sql, 'alice', 3)).not.toBeNull();
    expect(moderateGroupMembership(sql, 'alice', 'remove', 6)).toBe(true);
    expect(joinGroupMembership(sql, 'alice', 'forged rejoin', 7)).toBeNull();
    moderateGroupMembership(sql, 'alice', 'ban', 8);
    expect(joinGroupMembership(sql, 'alice', 'again', 9)).toBeNull();
    moderateGroupMembership(sql, 'alice', 'restore', 10);
    expect(activeGroupMember(sql, 'alice')).toBeNull();
    expect(joinGroupMembership(sql, 'alice', 'allowed', 11)!.version).toBeGreaterThan(next.version);
    expect(activeGroupMember(sql, 'alice', next.version)).toBeNull();
    expect(moderateGroupMembership(sql, 'absent', 'restore', 12)).toBe(false);
  } finally {
    db.close();
  }
});
