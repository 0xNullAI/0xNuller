import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
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
 * Only the parts we use are implemented: prepare / bind / first / all / run. The
 * rest of D1's interface is not needed here.
 */

// Use import.meta.dirname rather than new URL(import.meta.url) — the latter runs
// into the conflict between @cloudflare/workers-types' and node's URL type
// definitions.
const MIGRATIONS_DIR = join(import.meta.dirname, '../migrations');

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

  async all<T>(): Promise<{ results: T[]; success: true }> {
    return {
      results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[],
      success: true,
    };
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
  // Every migration, in file order, rather than a hand-maintained list: a new
  // migration that nobody remembered to add here would leave the tests running
  // against an older schema than production, which is the one kind of drift the
  // suite exists to catch.
  //
  // Each file goes to exec() whole. exec() runs every statement in the string and
  // SQLite does its own parsing, so splitting on ';' here — which is what this used
  // to do — only added a splitter that cannot see comments: one semicolon inside a
  // `--` line and the migration is cut in half mid-statement.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return {
    DB: {
      prepare: (sql: string) => new Stmt(db, sql),
      batch: async (statements: Stmt[]) =>
        Promise.all(statements.map((statement) => statement.run())),
    },
    close: () => db.close(),
  };
}
