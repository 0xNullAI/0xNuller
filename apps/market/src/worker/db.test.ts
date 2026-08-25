import { describe, expect, it, vi } from 'vitest';
import { listAdminItems } from './db';

function row(id: string, type: 'scenario' | 'multi-scene') {
  return {
    id,
    type,
    name: id,
    description: null,
    author: null,
    icon: null,
    tags: null,
    content:
      type === 'scenario'
        ? '{"prompt":"prompt"}'
        : '{"setting":"setting","roles":[{"name":"role"}]}',
    downloads: 0,
    views: 0,
    hidden: 0,
    created_at: 1,
  };
}

describe('Market admin listing', () => {
  it('applies aggregate category, visibility, search, and offset before pagination', async () => {
    let sql = '';
    let binds: unknown[] = [];
    const db = {
      prepare: vi.fn((statement: string) => {
        sql = statement;
        return {
          bind: vi.fn((...values: unknown[]) => {
            binds = values;
            return {
              all: vi.fn(async () => ({
                results: [row('solo', 'scenario'), row('party', 'multi-scene')],
              })),
            };
          }),
        };
      }),
    };

    const result = await listAdminItems(db as unknown as D1Database, {
      type: 'scenario',
      status: 'visible',
      q: 'mist',
      limit: 20,
      offset: 40,
    });

    expect(sql).toContain('type IN (?, ?)');
    expect(sql).toContain('hidden = 0');
    expect(sql).toContain('(name LIKE ? OR description LIKE ? OR author LIKE ?)');
    expect(sql.indexOf('type IN')).toBeLessThan(sql.indexOf('LIMIT ? OFFSET ?'));
    expect(sql.indexOf('hidden = 0')).toBeLessThan(sql.indexOf('LIMIT ? OFFSET ?'));
    expect(sql.indexOf('name LIKE')).toBeLessThan(sql.indexOf('LIMIT ? OFFSET ?'));
    expect(binds).toEqual(['scenario', 'multi-scene', '%mist%', '%mist%', '%mist%', 20, 40]);
    expect(result.map((item) => item.type)).toEqual(['scenario', 'multi-scene']);
  });
});
