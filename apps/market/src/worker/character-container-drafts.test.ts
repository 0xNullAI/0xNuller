/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync, zlibSync } from 'fflate';
import { afterEach, expect, it } from 'vitest';
import worker from './index';
import {
  cleanUnfinishedCharacterContainers,
  purgeDeletedAccountContainers,
} from './character-container-drafts';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function setup() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const file of [
    '0000_init.sql',
    '0001_add_edit_key.sql',
    '0010_character_container_drafts.sql',
  ])
    sql.exec(readFileSync(join(import.meta.dirname, '../../migrations', file), 'utf8'));
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
        objects.set(key, bytes.slice());
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { body: new Blob([new Uint8Array(bytes)]).stream() } : null;
      },
      head: async (key: string) => (objects.has(key) ? { key } : null),
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as unknown as R2Bucket,
    AUTH: {
      marketAccountIdentity: async ({ authorization }: { authorization: string | null }) =>
        authorization?.startsWith('Bearer ') ? { id: authorization.slice(7) } : null,
      marketAccountActive: async (id: string) => id !== 'deleted',
    },
  };
  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://market.test${path}`, init), env as never);
  return { sql, objects, env, request };
}

const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '测试角色' } };
const zip = zipSync({ 'card.json': strToU8(JSON.stringify(card)) });
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const n = (value: number) => Buffer.from([value >>> 24, value >>> 16, value >>> 8, value]);
  return Buffer.concat([n(payload.length), body, n((crc ^ 0xffffffff) >>> 0)]);
}
const png = Buffer.concat([
  Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0)),
  chunk('tEXt', strToU8(`ccv3\0${Buffer.from(JSON.stringify(card)).toString('base64')}`)),
  chunk('IDAT', zlibSync(Uint8Array.of(0, 255, 0, 0, 255))),
  chunk('IEND', new Uint8Array()),
]);
const auth = { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' };

it('keeps uploaded originals owner-only and returns exact bytes without inline execution', async () => {
  const { request, objects } = setup();
  const path = '/api/items/character-container-drafts';
  expect(
    (await request(path, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }))
      .status,
  ).toBe(401);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer alice',
          'X-Account-Id': 'bob',
          'Content-Type': 'image/png',
        },
        body: png,
      })
    ).status,
  ).toBe(401);
  const upload = await request(path, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/png' },
    body: png,
  });
  expect(upload.status).toBe(201);
  const { id } = (await upload.json()) as { id: string };
  expect(objects.size).toBe(1);
  const listing = await request(path, { headers: auth });
  expect(await listing.json()).toEqual({
    items: [{ id, type: 'png', bytes: png.length, createdAt: expect.any(Number) }],
  });
  expect(
    await (
      await request(path, {
        headers: {
          Authorization: 'Bearer bob',
          'X-Account-Id': 'bob',
        },
      })
    ).json(),
  ).toEqual({ items: [] });
  const content = `${path}/${id}/content`;
  expect((await request(content)).status).toBe(401);
  expect((await request(content, { method: 'HEAD', headers: auth })).status).toBe(204);
  expect(
    (
      await request(content, {
        method: 'HEAD',
        headers: { Authorization: 'Bearer bob', 'X-Account-Id': 'bob' },
      })
    ).status,
  ).toBe(404);
  expect(
    (await request(content, { headers: { Authorization: 'Bearer bob', 'X-Account-Id': 'bob' } }))
      .status,
  ).toBe(404);
  const downloaded = await request(content, { headers: auth });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get('Content-Disposition')).toContain('attachment');
  expect(downloaded.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(downloaded.headers.get('Cache-Control')).toBe('private, no-store');
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(Uint8Array.from(png));
  expect(
    (
      await request(`${path}/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer bob',
          'X-Account-Id': 'bob',
        },
      })
    ).status,
  ).toBe(404);
  expect((await request(`${path}/${id}`, { method: 'DELETE', headers: auth })).status).toBe(204);
  expect(objects.size).toBe(0);
  expect((await request(content, { headers: auth })).status).toBe(404);
});

it('rejects oversized and mislabeled bytes, and enforces an atomic per-owner file limit', async () => {
  const { request, sql, objects } = setup();
  const path = '/api/items/character-container-drafts';
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'text/html' },
        body: png,
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'image/png' },
        body: zip,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/zip' },
        body: png,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/zip' },
        body: Uint8Array.of(80, 75, 3, 4, 0),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'image/png' },
        body: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'image/png' },
        body: new Uint8Array(20_000_001),
      })
    ).status,
  ).toBe(413);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_container_drafts').get()).toMatchObject({
    n: 0,
  });
  const responses = await Promise.all(
    Array.from({ length: 21 }, () =>
      request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/zip' },
        body: zip,
      }),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  expect(objects.size).toBe(20);
  const { id } = (await responses.find((response) => response.status === 201)!.json()) as {
    id: string;
  };
  expect((await request(`${path}/${id}`, { method: 'DELETE', headers: auth })).status).toBe(204);
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/zip' },
        body: zip,
      })
    ).status,
  ).toBe(429);
});

it('caps total retained bytes independently of the file-count quota', async () => {
  const { request, sql } = setup();
  for (let index = 0; index < 5; index++) {
    sql
      .prepare(
        'INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        `existing-${index}`,
        'alice',
        `character-container-drafts/alice/existing-${index}`,
        'application/zip',
        20_000_000,
        'ready',
        1,
      );
  }
  const result = await request('/api/items/character-container-drafts', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  });
  expect(result.status).toBe(429);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_container_drafts').get()).toEqual({
    n: 5,
  });
});

it('retries interrupted deletion and leaves ready originals untouched', async () => {
  const { sql, objects, env } = setup();
  for (const [id, status, created] of [
    ['old', 'uploading', 1],
    ['deleting', 'deleting', 1],
    ['ready', 'ready', 1],
  ] as const) {
    const key = `character-container-drafts/alice/${id}`;
    sql
      .prepare(
        'INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, 'alice', key, 'image/png', png.length, status, created);
    objects.set(key, png);
  }
  await cleanUnfinishedCharacterContainers(env, 86_400_002);
  expect(sql.prepare('SELECT id FROM character_container_drafts').all()).toEqual([{ id: 'ready' }]);
  expect([...objects.keys()]).toEqual(['character-container-drafts/alice/ready']);
});

it('cleans an interrupted R2 upload and allows the owner to find a ready file after response loss', async () => {
  const { request, sql, objects, env } = setup();
  const bucket = env.PORTRAITS as unknown as {
    put: (key: string, bytes: Uint8Array) => Promise<void>;
  };
  bucket.put = async () => {
    throw new Error('R2 unavailable');
  };
  expect(
    (
      await request('/api/items/character-container-drafts', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/zip' },
        body: zip,
      })
    ).status,
  ).toBe(500);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_container_drafts').get()).toEqual({
    n: 0,
  });
  expect(objects.size).toBe(0);
  bucket.put = async (key, bytes) => {
    objects.set(key, bytes.slice());
  };
  const upload = await request('/api/items/character-container-drafts', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/zip' },
    body: zip,
  });
  const { id } = (await upload.json()) as { id: string };
  // The client loses the upload response and has no id; the owner list remains a recovery path.
  const listing = await request('/api/items/character-container-drafts', { headers: auth });
  expect(await listing.json()).toEqual({
    items: [{ id, type: 'charx', bytes: zip.length, createdAt: expect.any(Number) }],
  });
});

it('purges deleted accounts by owner in bounded scans, including R2 bytes', async () => {
  const { sql, objects, env } = setup();
  for (const id of ['one', 'two']) {
    const key = `character-container-drafts/deleted/${id}`;
    sql
      .prepare(
        'INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, 'deleted', key, 'image/png', png.length, 'ready', 1);
    objects.set(key, png);
  }
  sql
    .prepare(
      'INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      'live',
      'alice',
      'character-container-drafts/alice/live',
      'image/png',
      png.length,
      'ready',
      1,
    );
  objects.set('character-container-drafts/alice/live', png);
  await purgeDeletedAccountContainers(env, 123);
  expect(sql.prepare('SELECT id FROM character_container_drafts').all()).toEqual([{ id: 'live' }]);
  expect([...objects.keys()]).toEqual(['character-container-drafts/alice/live']);
  expect(
    sql.prepare('SELECT last_checked_at FROM character_container_drafts WHERE id=?').get('live'),
  ).toEqual({ last_checked_at: 123 });
});

it('keeps deletion markers for R2 failures so the next sweep can finish cleanup', async () => {
  const { sql, objects, env } = setup();
  const key = 'character-container-drafts/deleted/retry';
  sql
    .prepare(
      'INSERT INTO character_container_drafts(id,owner_id,object_key,mime,byte_size,status,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run('retry', 'deleted', key, 'image/png', png.length, 'ready', 1);
  objects.set(key, png);
  const bucket = env.PORTRAITS as unknown as { delete: (key: string) => Promise<void> };
  bucket.delete = async () => {
    throw new Error('temporary R2 failure');
  };
  await purgeDeletedAccountContainers(env, 123);
  expect(
    sql.prepare('SELECT status FROM character_container_drafts WHERE id=?').get('retry'),
  ).toEqual({ status: 'deleting' });
  bucket.delete = async (objectKey) => {
    objects.delete(objectKey);
  };
  await cleanUnfinishedCharacterContainers(env, 124);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM character_container_drafts').get()).toEqual({
    n: 0,
  });
  expect(objects.size).toBe(0);
});

it('adds private storage metadata without rewriting legacy public items', () => {
  const { sql } = setup();
  sql
    .prepare('INSERT INTO items(id,type,name,content,created_at) VALUES(?,?,?,?,?)')
    .run('legacy', 'scenario', '旧卡', 'not-json', 1);
  expect(sql.prepare('SELECT content FROM items WHERE id=?').get('legacy')).toEqual({
    content: 'not-json',
  });
});
