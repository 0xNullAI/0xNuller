import type { Env } from './index';
import { DurableObject } from 'cloudflare:workers';
/** Reverse admission index, not a user-editable bookmark list. Tombstones are permanent. */
export class AccountRegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS account_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),account_id TEXT NOT NULL,deletion_id TEXT,deleted_at INTEGER)',
    );
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS account_rooms(room TEXT PRIMARY KEY,registered_at INTEGER NOT NULL,revoked_at INTEGER)',
    );
  }
  private identity(account: string): void {
    if (!account || account.length > 256) throw new Error('invalid account');
    this.sql.exec('INSERT OR IGNORE INTO account_state(singleton,account_id) VALUES(1,?)', account);
    if (
      this.sql.exec('SELECT account_id FROM account_state WHERE singleton=1').toArray()[0]
        ?.account_id !== account
    )
      throw new Error('account mismatch');
  }
  async isActive(account: string): Promise<boolean> {
    this.identity(account);
    return !this.sql.exec('SELECT deletion_id FROM account_state WHERE singleton=1').toArray()[0]
      ?.deletion_id;
  }
  async registerGroup(
    account: string,
    room: string,
    existingMembership = false,
  ): Promise<{ allowed: boolean; deletionId: string | null }> {
    this.identity(account);
    const state = this.sql
      .exec('SELECT deletion_id FROM account_state WHERE singleton=1')
      .toArray()[0]!;
    if (!state.deletion_id || existingMembership)
      this.sql.exec(
        'INSERT OR IGNORE INTO account_rooms(room,registered_at) VALUES(?,?)',
        room,
        Date.now(),
      );
    return { allowed: !state.deletion_id, deletionId: state.deletion_id as string | null };
  }
  async tombstone(
    account: string,
    deletionId: string,
    cursor = '',
  ): Promise<{
    accountId: string;
    deletionId: string;
    tombstoned: true;
    rooms: string[];
    nextCursor: string | null;
    coverage: 'registered-and-observed';
    legacyCoverage: 'unknown';
  }> {
    this.identity(account);
    const previous = this.sql
      .exec('SELECT deletion_id FROM account_state WHERE singleton=1')
      .toArray()[0]?.deletion_id;
    if (previous && previous !== deletionId) throw new Error('deletion job mismatch');
    this.sql.exec(
      'UPDATE account_state SET deletion_id=COALESCE(deletion_id,?),deleted_at=COALESCE(deleted_at,?) WHERE singleton=1',
      deletionId,
      Date.now(),
    );
    const rows = this.sql
      .exec(
        'SELECT room FROM account_rooms WHERE revoked_at IS NULL AND room>? ORDER BY room LIMIT 101',
        cursor,
      )
      .toArray();
    const rooms = rows.slice(0, 100).map((row) => String(row.room));
    return {
      accountId: account,
      deletionId,
      tombstoned: true,
      rooms,
      nextCursor: rows.length > 100 ? rooms.at(-1)! : null,
      coverage: 'registered-and-observed',
      legacyCoverage: 'unknown',
    };
  }
  async acknowledge(account: string, deletionId: string, room: string): Promise<void> {
    this.identity(account);
    if (
      this.sql.exec('SELECT deletion_id FROM account_state WHERE singleton=1').toArray()[0]
        ?.deletion_id !== deletionId
    )
      throw new Error('deletion not marked');
    this.sql.exec(
      'INSERT INTO account_rooms(room,registered_at,revoked_at) VALUES(?,?,?) ON CONFLICT(room) DO UPDATE SET revoked_at=excluded.revoked_at',
      room,
      Date.now(),
      Date.now(),
    );
  }
}
