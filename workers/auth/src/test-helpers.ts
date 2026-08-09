import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A subset of the D1 interface implemented on Node 26's built-in `node:sqlite`, for
 * use in tests.
 *
 * Why not a hand-written fake: the most error-prone part of the account service is
 * the SQL itself — UNIQUE constraints, `ON DELETE CASCADE`, the time-window
 * aggregation behind rate limiting. A fake would only repeat my own understanding
 * of the queries as I wrote them; only really running SQLite proves the constraints
 * actually take effect. It also means the migration file is genuinely executed, so
 * schema drift surfaces on the spot.
 *
 * Only the parts we use are implemented: prepare / bind / first / run. The rest of
 * D1's interface is not needed here.
 */

// Use import.meta.dirname rather than new URL(import.meta.url) — the latter runs
// into the conflict between @cloudflare/workers-types' and node's URL type
// definitions.
const MIGRATION = join(import.meta.dirname, '../migrations/0001_init.sql');

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row as T) ?? null;
  }

  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true };
  }
}

export function createTestDb(): { DB: unknown; close: () => void } {
  const db = new DatabaseSync(':memory:');
  // D1 enables foreign keys by default; node:sqlite does not, and without turning
  // them on explicitly ON DELETE CASCADE silently does nothing, which would make the
  // "sessions die immediately after account deletion" test pass falsely.
  db.exec('PRAGMA foreign_keys = ON');
  for (const stmt of readFileSync(MIGRATION, 'utf8').split(';')) {
    if (stmt.trim()) db.exec(stmt);
  }
  return {
    DB: { prepare: (sql: string) => new Stmt(db, sql) },
    close: () => db.close(),
  };
}
