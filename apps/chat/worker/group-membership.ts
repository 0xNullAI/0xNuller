import type { GroupMembership } from './wire';
export function initializeGroupMembership(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS group_account_revocations(account_id TEXT PRIMARY KEY,deletion_id TEXT NOT NULL,revoked_at INTEGER NOT NULL)',
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS group_memberships(account_id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','left','removed','banned')),version INTEGER NOT NULL,updated_at INTEGER NOT NULL)`,
  );
}
export function groupMembership(sql: SqlStorage, account: string): GroupMembership | null {
  return (
    (sql
      .exec(
        'SELECT account_id,name,state,version,updated_at FROM group_memberships WHERE account_id=?',
        account,
      )
      .toArray()[0] as unknown as GroupMembership | undefined) ?? null
  );
}
export function joinGroupMembership(
  sql: SqlStorage,
  account: string,
  name: string,
  now: number,
): GroupMembership | null {
  sql.exec(
    `INSERT INTO group_memberships(account_id,name,state,version,updated_at) VALUES(?,?,'active',1,?)
 ON CONFLICT(account_id) DO UPDATE SET name=excluded.name,state='active',version=version+CASE WHEN state='left' THEN 1 ELSE 0 END,updated_at=excluded.updated_at WHERE state IN ('active','left')`,
    account,
    name.slice(0, 40),
    now,
  );
  const member = groupMembership(sql, account);
  return member?.state === 'active' ? member : null;
}
/** Version check makes a late leave from an old socket unable to revoke a later rejoin. */
export function leaveGroupMembership(
  sql: SqlStorage,
  account: string,
  version: number,
  now: number,
): boolean {
  return (
    sql
      .exec(
        "UPDATE group_memberships SET state='left',version=version+1,updated_at=? WHERE account_id=? AND version=? AND state='active' RETURNING account_id",
        now,
        account,
        version,
      )
      .toArray().length > 0
  );
}
export function moderateGroupMembership(
  sql: SqlStorage,
  account: string,
  action: 'remove' | 'ban' | 'restore',
  now: number,
): boolean {
  const state = action === 'restore' ? 'left' : action === 'ban' ? 'banned' : 'removed';
  return (
    sql
      .exec(
        `UPDATE group_memberships SET state=?,version=version+1,updated_at=? WHERE account_id=? AND state<>? RETURNING account_id`,
        state,
        now,
        account,
        state,
      )
      .toArray().length > 0
  );
}
export function activeGroupMember(
  sql: SqlStorage,
  account: string,
  version?: number,
): GroupMembership | null {
  const member = groupMembership(sql, account);
  return member?.state === 'active' && (version === undefined || member.version === version)
    ? member
    : null;
}
