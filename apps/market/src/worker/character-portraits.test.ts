/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { emptyCharacterCard } from '@0xnullai/scenes/character-card';
import worker from './index';
import { cleanUnfinishedPortraits, validatePortraitReference } from './character-portraits';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return Buffer.concat([u32(payload.length), body, u32((crc ^ 0xffffffff) >>> 0)]);
}

const tinyPng = Buffer.concat([
  Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0)),
  chunk('IDAT', deflateSync(Uint8Array.of(0, 255, 0, 0, 255))),
  chunk('IEND', new Uint8Array()),
]);

function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '0000_init.sql',
    '0001_add_edit_key.sql',
    '0007_character_versions.sql',
    '0008_character_portraits.sql',
  ]) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', file), 'utf8'));
  }
  const objects = new Map<string, Uint8Array>();
  const prepare = (query: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => prepare(query, values),
    first: async () => sql.prepare(query).get(...(args as never[])) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: sql.prepare(query).run(...(args as never[])).changes } }),
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    PORTRAITS: {
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { body: new Blob([new Uint8Array(bytes)]).stream() } : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as unknown as R2Bucket,
    AUTH: {
      marketAccountIdentity: async ({ authorization }: { authorization: string | null }) =>
        authorization?.startsWith('Bearer ') ? { id: authorization.slice(7) } : null,
      marketItemAccess: async () => 'owner' as const,
    },
  };
  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://market.test${path}`, init), env as never);
  return { sql, objects, env, request };
}

it('stores a sanitized portrait privately, publishes it only with a visible card, then revokes public access on hide', async () => {
  const { request, sql, objects } = setup();
  const unauthenticated = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: tinyPng,
  });
  expect(unauthenticated.status).toBe(401);

  const upload = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
    body: tinyPng,
  });
  expect(upload.status).toBe(201);
  const { id } = (await upload.json()) as { id: string };
  expect(objects.size).toBe(1);
  const contentPath = `/api/items/character-portraits/${id}/content`;
  expect((await request(contentPath)).status).toBe(404);
  expect((await request(contentPath, { headers: { Authorization: 'Bearer bob' } })).status).toBe(
    404,
  );
  const preview = await request(contentPath, { headers: { Authorization: 'Bearer alice' } });
  expect(preview.status).toBe(200);
  expect(preview.headers.get('Cache-Control')).toBe('no-store');
  expect(preview.headers.get('Content-Type')).toBe('image/png');
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(Uint8Array.from(tinyPng));

  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run(
      'card-1',
      'scenario',
      '测试人物',
      JSON.stringify({ prompt: '角色设定', characterCard: emptyCharacterCard(), portraitId: id }),
      1,
    );
  expect((await request(contentPath)).status).toBe(200);
  sql
    .prepare('UPDATE items SET content=?,revision=revision+1 WHERE id=?')
    .run(JSON.stringify({ prompt: '新版人设', characterCard: emptyCharacterCard() }), 'card-1');
  expect((await request(contentPath)).status).toBe(404);
  expect((await request(contentPath, { headers: { Authorization: 'Bearer alice' } })).status).toBe(
    200,
  );
  sql.prepare('UPDATE items SET hidden=1 WHERE id=?').run('card-1');
  expect((await request(contentPath)).status).toBe(404);
  expect((await request(contentPath, { headers: { Authorization: 'Bearer alice' } })).status).toBe(
    200,
  );
});

it('rejects borrowed portraits and invalid uploads before card publication', async () => {
  const { request, env, sql } = setup();
  expect(
    (
      await request('/api/items/character-portraits', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Content-Type': 'text/plain' },
        body: 'not an image',
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await request('/api/items/character-portraits', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
        body: 'not an image',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request('/api/items/character-portraits', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
        body: new Uint8Array(4_000_001),
      })
    ).status,
  ).toBe(413);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_portraits').get()).toMatchObject({
    n: 0,
  });
  const upload = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
    body: tinyPng,
  });
  const { id } = (await upload.json()) as { id: string };
  expect(
    await validatePortraitReference(
      env,
      new Request('https://market.test/', {
        headers: { Authorization: 'Bearer bob' },
      }),
      id,
    ),
  ).toBe('forbidden');
  expect(await validatePortraitReference(env, new Request('https://market.test/'), id)).toBe(
    'unauthorized',
  );
  expect(
    (
      await request('/api/items', {
        method: 'POST',
        headers: { Authorization: 'Bearer bob', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'scenario',
          name: 'Borrowed',
          content: { prompt: 'Persona', characterCard: emptyCharacterCard(), portraitId: id },
        }),
      })
    ).status,
  ).toBe(403);
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run(
      'card-bob',
      'scenario',
      'Bob',
      JSON.stringify({ prompt: 'Persona', characterCard: emptyCharacterCard() }),
      1,
    );
  expect(
    (
      await request('/api/items/card-bob', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer bob', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          content: { prompt: 'Persona', characterCard: emptyCharacterCard(), portraitId: id },
        }),
      })
    ).status,
  ).toBe(403);
});

it('strips imported PNG text metadata and rejects a corrupt chunk checksum', async () => {
  const { request, objects } = setup();
  const signature = tinyPng.subarray(0, 8);
  const header = tinyPng.subarray(8, 33);
  const imageAndEnd = tinyPng.subarray(33);
  const withMetadata = Buffer.concat([
    signature,
    header,
    chunk('tEXt', new TextEncoder().encode('Comment\0private card data')),
    imageAndEnd,
  ]);
  const upload = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
    body: withMetadata,
  });
  expect(upload.status).toBe(201);
  expect(Uint8Array.from([...objects.values()][0]!)).toEqual(Uint8Array.from(tinyPng));

  const corrupted = Uint8Array.from(tinyPng);
  corrupted[25] = corrupted[25]! ^ 1;
  expect(
    (
      await request('/api/items/character-portraits', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
        body: corrupted,
      })
    ).status,
  ).toBe(400);
});

it('cleans only stale interrupted uploads, preserving ready images', async () => {
  const { env, sql, objects } = setup();
  sql
    .prepare('INSERT INTO character_portraits VALUES(?,?,?,?,?,?)')
    .run('stale', 'alice', 'characters/alice/stale', 'image/png', 'uploading', 1);
  sql
    .prepare('INSERT INTO character_portraits VALUES(?,?,?,?,?,?)')
    .run('ready', 'alice', 'characters/alice/ready', 'image/png', 'ready', 1);
  sql
    .prepare('INSERT INTO character_portraits VALUES(?,?,?,?,?,?)')
    .run('deleting', 'alice', 'characters/alice/deleting', 'image/png', 'deleting', 1);
  objects.set('characters/alice/stale', tinyPng);
  objects.set('characters/alice/ready', tinyPng);
  objects.set('characters/alice/deleting', tinyPng);
  await cleanUnfinishedPortraits(env, 86_400_002);
  expect(sql.prepare('SELECT id FROM character_portraits').all()).toEqual([{ id: 'ready' }]);
  expect([...objects.keys()]).toEqual(['characters/alice/ready']);
});

it('reserves the daily upload limit atomically under concurrent requests', async () => {
  const { request, sql, objects } = setup();
  const responses = await Promise.all(
    Array.from({ length: 31 }, () =>
      request('/api/items/character-portraits', {
        method: 'POST',
        headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
        body: tinyPng,
      }),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(30);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_portraits').get()).toMatchObject({
    n: 30,
  });
  expect(objects.size).toBe(30);
});

it('adds the portrait index without rewriting even malformed legacy content', () => {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const file of ['0000_init.sql', '0001_add_edit_key.sql', '0007_character_versions.sql']) {
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', file), 'utf8'));
  }
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run('legacy', 'scenario', '旧内容', 'not-json', 1);
  sql.exec(
    readFileSync(
      join(import.meta.dirname, '../../migrations/0008_character_portraits.sql'),
      'utf8',
    ),
  );
  expect(sql.prepare('SELECT content FROM items WHERE id=?').get('legacy')).toEqual({
    content: 'not-json',
  });
});

it('lets only the owner delete an unreferenced image and rejects a stale publish at the final D1 write', async () => {
  const { request, sql, objects, env } = setup();
  const upload = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
    body: tinyPng,
  });
  const { id } = (await upload.json()) as { id: string };
  const path = `/api/items/character-portraits/${id}`;
  expect((await request(path, { method: 'DELETE' })).status).toBe(401);
  expect(
    (await request(path, { method: 'DELETE', headers: { Authorization: 'Bearer bob' } })).status,
  ).toBe(404);
  expect(
    await validatePortraitReference(
      env,
      new Request('https://market.test/', { headers: { Authorization: 'Bearer alice' } }),
      id,
    ),
  ).toBe('ok');
  expect(
    (await request(path, { method: 'DELETE', headers: { Authorization: 'Bearer alice' } })).status,
  ).toBe(204);
  expect(objects.size).toBe(0);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_portraits').get()).toMatchObject({
    n: 0,
  });
  expect(() =>
    sql
      .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
      .run(
        'late-card',
        'scenario',
        'Late',
        JSON.stringify({ prompt: 'Persona', characterCard: emptyCharacterCard(), portraitId: id }),
        1,
      ),
  ).toThrow(/invalid character portrait/);
});

it('retains images referenced by current or archived versions', async () => {
  const { request, sql, objects } = setup();
  const upload = await request('/api/items/character-portraits', {
    method: 'POST',
    headers: { Authorization: 'Bearer alice', 'Content-Type': 'image/png' },
    body: tinyPng,
  });
  const { id } = (await upload.json()) as { id: string };
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run(
      'card-1',
      'scenario',
      'Card',
      JSON.stringify({ prompt: 'Persona', characterCard: emptyCharacterCard(), portraitId: id }),
      1,
    );
  const remove = () =>
    request(`/api/items/character-portraits/${id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer alice' },
    });
  expect((await remove()).status).toBe(409);
  sql
    .prepare('UPDATE items SET content=?,revision=revision+1 WHERE id=?')
    .run(JSON.stringify({ prompt: 'Next', characterCard: emptyCharacterCard() }), 'card-1');
  expect((await remove()).status).toBe(409);
  expect(objects.size).toBe(1);
});
