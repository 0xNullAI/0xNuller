/// <reference types="node" />
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  parseHistoryCursor,
  parseSearchQuery,
  readHistoryPage,
  searchHistory,
} from './room-history';

describe('服务器群与私聊历史分页', () => {
  it('同毫秒消息按配对游标全部回读，不重复、不遗漏', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE TABLE messages(id TEXT PRIMARY KEY,from_id TEXT,name TEXT,body TEXT,ts INTEGER);' +
          ' CREATE TABLE message_sequences(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_account TEXT)',
      );
      const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
      for (let i = 0; i < 245; i++)
        insert.run(
          `m${String(i).padStart(3, '0')}`,
          'alice',
          'Alice',
          JSON.stringify({ x: `正文${i}` }),
          100,
        );
      const sql = {
        exec: (query: string, ...args: unknown[]) => ({
          toArray: () => db.prepare(query).all(...(args as never[])),
        }),
      } as unknown as SqlStorage;
      const first = readHistoryPage(sql);
      expect(first.messages).toHaveLength(100);
      expect(first.messages.at(-1)?.id).toBe('m244');
      const second = readHistoryPage(sql, first.before!);
      const third = readHistoryPage(sql, second.before!);
      expect(third.before).toBeNull();
      const ids = [...third.messages, ...second.messages, ...first.messages].map(
        (message) => message.id,
      );
      expect(ids).toHaveLength(245);
      expect(new Set(ids).size).toBe(245);
      expect(readHistoryPage(sql, undefined, 1000).messages).toHaveLength(245);
    } finally {
      db.close();
    }
  });
  it('拒绝不合法分页游标', () => {
    expect(parseHistoryCursor({ ts: -1, id: 'a' })).toBeNull();
    expect(parseHistoryCursor({ ts: 1, id: '' })).toBeNull();
    expect(parseHistoryCursor({ ts: 1, id: 'a' })).toEqual({ ts: 1, id: 'a' });
  });
});

it('names the sender account in history so a client recognises its own messages after reload', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE messages(id TEXT PRIMARY KEY,from_id TEXT,name TEXT,body TEXT,ts INTEGER);' +
        ' CREATE TABLE message_sequences(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_account TEXT)',
    );
    db.exec(
      `INSERT INTO messages VALUES ('mine','old-peer','Alice','{"x":"hi"}',1),('ai','ai:room','助手','{"x":"嗨"}',2)`,
    );
    db.exec(
      `INSERT INTO message_sequences(message_id,sender_account) VALUES ('mine','alice'),('ai','agent:ai:room')`,
    );
    const sql = {
      exec: (query: string, ...args: unknown[]) => ({
        toArray: () => db.prepare(query).all(...(args as never[])),
      }),
    } as unknown as SqlStorage;
    const page = readHistoryPage(sql);
    expect(page.messages.map((message) => message._account)).toEqual(['alice', undefined]);
  } finally {
    db.close();
  }
});

describe('聊天记录搜索', () => {
  it('只返回未撤回且包含关键词的消息，新消息在前', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE TABLE messages(id TEXT PRIMARY KEY,from_id TEXT,name TEXT,body TEXT,ts INTEGER);' +
          ' CREATE TABLE message_sequences(sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_account TEXT)',
      );
      const insert = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
      insert.run('a', 'p1', 'Alice', JSON.stringify({ x: '今晚买猫粮' }), 1);
      insert.run('b', 'p2', 'Bob', JSON.stringify({ x: 'Cat FOOD 到了' }), 2);
      insert.run('c', 'p1', 'Alice', JSON.stringify({ recalled: true }), 3);
      insert.run('d', 'p2', 'Bob', JSON.stringify({ m: { kind: 'image' } }), 4);
      insert.run('e', 'ai:room', 'AI', JSON.stringify({ x: '猫粮已记下' }), 5);
      db.prepare('INSERT INTO message_sequences(message_id,sender_account) VALUES (?,?)').run(
        'a',
        'acct-a',
      );
      db.prepare('INSERT INTO message_sequences(message_id,sender_account) VALUES (?,?)').run(
        'e',
        'agent:room',
      );
      const sql = {
        exec: (query: string, ...args: unknown[]) => ({
          toArray: () => db.prepare(query).all(...(args as never[])),
        }),
      } as unknown as SqlStorage;
      expect(searchHistory(sql, '猫粮').map((hit) => hit.id)).toEqual(['e', 'a']);
      expect(searchHistory(sql, '猫粮')[1]).toMatchObject({ _account: 'acct-a', x: '今晚买猫粮' });
      expect(searchHistory(sql, '猫粮')[0]).not.toHaveProperty('_account');
      expect(searchHistory(sql, 'cat food').map((hit) => hit.id)).toEqual(['b']);
      expect(searchHistory(sql, '撤回')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('拒绝空白与过长的关键词', () => {
    expect(parseSearchQuery('  猫  ')).toBe('猫');
    expect(parseSearchQuery('   ')).toBeNull();
    expect(parseSearchQuery('x'.repeat(65))).toBeNull();
    expect(parseSearchQuery(3)).toBeNull();
  });
});
