import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用 Node 26 内置的 `node:sqlite` 实现 D1 接口的一个子集，供测试使用。
 *
 * 为什么不用手写的假对象：账号服务里最容易出错的地方恰恰在 SQL 本身——UNIQUE 约束、
 * `ON DELETE CASCADE`、限流的时间窗口聚合。假对象只会重复我写查询时的理解，真跑一遍
 * SQLite 才能证明约束确实生效。迁移文件也由此被真正执行，schema 漂移会当场暴露。
 *
 * 只实现用到的部分：prepare / bind / first / run。D1 的其余接口这里用不到。
 */

// 用 import.meta.dirname 而不是 new URL(import.meta.url)——后者会撞上
// @cloudflare/workers-types 与 node 的 URL 类型定义冲突。
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
  // D1 默认开启外键；node:sqlite 不开，不显式打开的话 ON DELETE CASCADE 会静默失效，
  // 「注销账号后会话立即失效」这条测试就会假通过。
  db.exec('PRAGMA foreign_keys = ON');
  for (const stmt of readFileSync(MIGRATION, 'utf8').split(';')) {
    if (stmt.trim()) db.exec(stmt);
  }
  return {
    DB: { prepare: (sql: string) => new Stmt(db, sql) },
    close: () => db.close(),
  };
}
