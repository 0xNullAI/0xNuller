import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { validRoom, type RoomIndexKind, type RoomIndexSource } from './room-index';

/** Durable enumeration ledger. It never grants room access or rewrites a deletion tombstone. */
export class RoomIndexDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(
      code TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      deleted_at INTEGER, deletion_reason TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS account_tombstones(
      account_id TEXT PRIMARY KEY, deletion_id TEXT NOT NULL, deleted_at INTEGER NOT NULL)`);
  }

  async register(
    code: string,
    kind: RoomIndexKind,
    source: RoomIndexSource = 'admission',
  ): Promise<void> {
    if (!validRoom(code, kind)) throw new Error('invalid room');
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO rooms(code,kind,source,first_seen,last_seen)
      VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
      last_seen=excluded.last_seen,
      source=CASE WHEN rooms.source='historical-hint' THEN excluded.source ELSE rooms.source END`,
      code,
      kind,
      source,
      now,
      now,
    );
  }

  async tombstone(code: string, kind: RoomIndexKind, reason: 'closed' | 'expired'): Promise<void> {
    if (!validRoom(code, kind)) throw new Error('invalid room');
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO rooms(code,kind,source,first_seen,last_seen,deleted_at,deletion_reason)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
      deleted_at=COALESCE(rooms.deleted_at,excluded.deleted_at),
      deletion_reason=COALESCE(rooms.deletion_reason,excluded.deletion_reason)`,
      code,
      kind,
      'admission',
      now,
      now,
      now,
      reason,
    );
  }

  async list(
    after = '',
  ): Promise<{ rooms: Record<string, SqlStorageValue>[]; cursor: string | null }> {
    if (after.length > 128) throw new Error('invalid cursor');
    const rows = this.sql
      .exec(
        `SELECT code,kind,source,first_seen,last_seen,deleted_at,deletion_reason
      FROM rooms WHERE code>? ORDER BY code LIMIT 101`,
        after,
      )
      .toArray();
    const page = rows.slice(0, 100);
    return { rooms: page, cursor: rows.length > 100 ? String(page.at(-1)!.code) : null };
  }

  async tombstoneAccount(account: string, deletionId: string): Promise<void> {
    if (!account || account.length > 256 || !deletionId || deletionId.length > 512)
      throw new Error('invalid account deletion');
    const row = this.sql
      .exec('SELECT deletion_id FROM account_tombstones WHERE account_id=?', account)
      .toArray()[0];
    if (row && row.deletion_id !== deletionId) throw new Error('deletion job mismatch');
    this.sql.exec(
      'INSERT OR IGNORE INTO account_tombstones(account_id,deletion_id,deleted_at) VALUES(?,?,?)',
      account,
      deletionId,
      Date.now(),
    );
  }

  async listAccountTombstones(after = ''): Promise<{
    accounts: Record<string, SqlStorageValue>[];
    cursor: string | null;
  }> {
    if (after.length > 256) throw new Error('invalid cursor');
    const rows = this.sql
      .exec(
        `SELECT account_id,deletion_id,deleted_at FROM account_tombstones
      WHERE account_id>? ORDER BY account_id LIMIT 101`,
        after,
      )
      .toArray();
    const page = rows.slice(0, 100);
    return { accounts: page, cursor: rows.length > 100 ? String(page.at(-1)!.account_id) : null };
  }
}
