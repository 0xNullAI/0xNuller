/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
import worker from './index';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '0000_init.sql',
    '0001_add_edit_key.sql',
    '0007_character_versions.sql',
    '0012_unified_prompt_card_versions.sql',
  ]) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', file), 'utf8'));
  }
  const card = emptyCharacterCard();
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run(
      'card-1',
      'scenario',
      '初版',
      JSON.stringify({ prompt: '第一版', characterCard: card }),
      1,
    );
  sql
    .prepare('UPDATE items SET name=?,content=?,revision=revision+1 WHERE id=? AND revision=1')
    .run('新版', JSON.stringify({ prompt: '第二版', characterCard: card }), 'card-1');
  let access: 'owner' | 'user' | 'unauthorized' = 'owner';
  const prepare = (query: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(query, values),
    first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: sql.prepare(query).run(...(args as never[])).changes } }),
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    AUTH: { marketItemAccess: async () => access },
  };
  const get = (path: string) =>
    worker.fetch(
      new Request(`https://market.test/api/items/card-1/revisions${path}`, {
        headers: { Authorization: 'Bearer session' },
      }),
      env as never,
    );
  return {
    get,
    sql,
    env,
    patch: (body: unknown) =>
      worker.fetch(
        new Request('https://market.test/api/items/card-1', {
          method: 'PATCH',
          headers: { Authorization: 'Bearer session', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env as never,
      ),
    setAccess: (value: typeof access) => {
      access = value;
    },
  };
}

it('includes old prompt-only scenes in the shared card history before and after editing', async () => {
  const { sql, env } = setup();
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run('plain-scene', 'scenario', '旧场景', JSON.stringify({ prompt: '旧设定' }), 1);
  const request = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`https://market.test/api/items/plain-scene${path}`, {
        headers: { Authorization: 'Bearer session', 'Content-Type': 'application/json' },
        ...init,
      }),
      env as never,
    );

  expect(await (await request('/revisions')).json()).toMatchObject({
    versions: [{ revision: 1, name: '旧场景', current: true }],
  });
  expect(
    (
      await request('', {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: 1,
          name: '新场景',
          content: { prompt: '新设定' },
        }),
      })
    ).status,
  ).toBe(200);
  expect(await (await request('/revisions')).json()).toMatchObject({
    versions: [
      { revision: 2, name: '新场景', current: true },
      { revision: 1, name: '旧场景', current: false },
    ],
  });
  expect(await (await request('/revisions/2')).json()).toMatchObject({
    snapshot: { content: { prompt: '新设定', kind: 'scene' } },
  });
  expect(await (await request('/revisions/1')).json()).toMatchObject({
    snapshot: { name: '旧场景', content: { prompt: '旧设定' } },
  });
});

it('serves private version history to the owner and restores the original public definition', async () => {
  const { get, setAccess } = setup();
  const list = await get('');
  expect(list.status).toBe(200);
  expect(list.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await list.json()).toMatchObject({
    versions: [
      { revision: 2, name: '新版', current: true },
      { revision: 1, name: '初版', current: false },
    ],
  });
  expect(await (await get('/1')).json()).toMatchObject({
    snapshot: { revision: 1, name: '初版', content: { prompt: '第一版' } },
  });
  expect(await (await get('/2')).json()).toMatchObject({
    snapshot: { revision: 2, name: '新版', content: { prompt: '第二版' } },
  });
  setAccess('user');
  expect((await get('')).status).toBe(403);
  expect((await get('/1')).status).toBe(403);
  setAccess('unauthorized');
  expect((await get('/1')).status).toBe(401);
});

it('keeps archived JSON through old-client edits and removes it only when explicitly requested', async () => {
  const { sql, patch, get } = setup();
  const sourceArchive = {
    format: 'ccv2',
    raw: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '新版', extensions: { future: true } },
    },
  };
  sql
    .prepare('UPDATE items SET content=? WHERE id=?')
    .run(
      JSON.stringify({ prompt: '第二版', characterCard: emptyCharacterCard(), sourceArchive }),
      'card-1',
    );
  expect((await patch({ expectedRevision: 2, content: { prompt: '第三版' } })).status).toBe(200);
  expect(await (await get('/3')).json()).toMatchObject({
    snapshot: { content: { sourceArchive } },
  });
  expect(
    (
      await patch({
        expectedRevision: 3,
        content: {
          prompt: '第四版',
          sourceArchive: null,
        },
      })
    ).status,
  ).toBe(200);
  expect(await (await get('/4')).json()).toMatchObject({
    snapshot: { content: { prompt: '第四版' } },
  });
  const content = JSON.parse(
    (sql.prepare('SELECT content FROM items WHERE id=?').get('card-1') as { content: string })
      .content,
  );
  expect(content.sourceArchive).toBeUndefined();
});
