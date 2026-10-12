import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCharacterAppearance } from './character-appearance';
import { handleCharacterRelationships } from './character-relationships';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const base = '/api/auth/character-appearance';
const draft = {
  characterId: 'builtin:companion-lan',
  aiNickname: '小雨',
  userPreferredName: '阿明',
  relationshipType: '朋友',
  notes: '一起读书',
  version: 0,
};
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, id, id, 'unused', 1)
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(await sha256Hex(id), id, 1, Date.now() + 60_000)
      .run();
  }
});
afterEach(() => db.close());
async function call(path = '', method = 'GET', body?: unknown, token = 'alice') {
  const result = await handleCharacterAppearance(
    new Request(`https://0xnullai.com${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  );
  if (!result) throw new Error('route not matched');
  return result;
}

async function seed() {
  await handleCharacterRelationships(
    new Request('https://example.com/api/auth/character-relationships/relation', {
      method: 'PUT',
      headers: { Authorization: 'Bearer alice' },
      body: JSON.stringify(draft),
    }),
    env,
    {},
  );
  for (const id of ['alice', 'bob'])
    await env.DB.prepare(
      "INSERT INTO user_photos (id,user_id,object_key,visibility,created_at,status) VALUES (?, ?, ?, 'private', 1, 'ready')",
    )
      .bind(`${id}-photo`, id, id)
      .run();
}
const appearance = { photoId: 'alice-photo', scale: 35, position: 'right', version: 0 };
describe('private character appearance', () => {
  it('requires owner relationship and owner ready photo, rejects URL injection', async () => {
    await seed();
    expect((await call('/relation', 'PUT', appearance, 'bob')).status).toBe(404);
    expect((await call('/relation', 'PUT', { ...appearance, photoId: 'bob-photo' })).status).toBe(
      400,
    );
    expect(
      (await call('/relation', 'PUT', { ...appearance, photoId: 'https://tracker.test/x' })).status,
    ).toBe(400);
    expect((await call('/relation', 'PUT', { ...appearance, scale: 100 })).status).toBe(400);
    expect((await call('/relation', 'PUT', appearance)).status).toBe(200);
    expect(await (await call('/relation')).json()).toMatchObject({
      item: { ...appearance, version: 1 },
    });
  });
  it('uses CAS, hides deleted photo and rejects deleted relationships or banned accounts', async () => {
    await seed();
    await call('/relation', 'PUT', appearance);
    expect((await call('/relation', 'PUT', appearance)).status).toBe(409);
    expect(
      (await call('/relation', 'PUT', { ...appearance, version: 1, position: 'left' })).status,
    ).toBe(200);
    await env.DB.prepare('DELETE FROM user_photos WHERE id = ?').bind('alice-photo').run();
    expect(await (await call('/relation')).json()).toMatchObject({
      item: { photoId: null, version: 2 },
    });
    await env.DB.prepare('UPDATE users SET banned_at = 1 WHERE id = ?').bind('alice').run();
    expect((await call('/relation')).status).toBe(403);
    await env.DB.prepare('UPDATE users SET banned_at = NULL WHERE id = ?').bind('alice').run();
    await env.DB.prepare('UPDATE character_relationships SET deleted_at = 1').run();
    expect((await call('/relation')).status).toBe(404);
  });
});
