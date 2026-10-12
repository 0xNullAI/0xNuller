import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCharacterRelationships } from './character-relationships';
import { sha256Hex, type SessionEnv } from './session-domain';
import { createTestDb } from './test-helpers';

let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
const base = '/api/auth/character-relationships';
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
  const result = await handleCharacterRelationships(
    new Request(`https://0xnullai.com${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Account-Id': token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  );
  if (!result) throw new Error('route not matched');
  return result;
}

describe('private character relationships', () => {
  it('materializes one private entity per account and public card without undoing deletion', async () => {
    const characterId = 'market-card-1';
    const first = (await (await call('/ensure', 'PUT', { characterId })).json()) as {
      item: { id: string; version: number; aiNickname: string };
    };
    expect(first.item).toMatchObject({ version: 1, aiNickname: '' });
    expect(await (await call('/ensure', 'PUT', { characterId })).json()).toMatchObject({
      item: { id: first.item.id },
    });
    const bob = (await (await call('/ensure', 'PUT', { characterId }, 'bob')).json()) as {
      item: { id: string };
    };
    expect(bob.item.id).not.toBe(first.item.id);
    expect((await call(`/${first.item.id}`, 'DELETE', { version: 1 })).status).toBe(200);
    expect((await call('/ensure', 'PUT', { characterId })).status).toBe(409);
    expect((await call('/new-private', 'PUT', { ...draft, characterId })).status).toBe(201);
  });
  it('requires auth, rejects banned accounts, isolates matching ids and never caches', async () => {
    expect((await call('', 'GET', undefined, 'missing')).status).toBe(401);
    const mismatch = await handleCharacterRelationships(
      new Request(`https://0xnullai.com${base}`, {
        headers: { Authorization: 'Bearer bob', 'X-Account-Id': 'alice' },
      }),
      env,
      {},
    );
    expect(mismatch?.status).toBe(403);
    expect(mismatch?.headers.get('cache-control')).toBe('no-store');
    const saved = await call('/relationship', 'PUT', draft);
    expect(saved.status).toBe(201);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(await (await call('/relationship')).json()).toMatchObject({
      item: { ...draft, id: 'relationship', version: 1 },
    });
    expect(await (await call('', 'GET', undefined, 'bob')).json()).toMatchObject({ items: [] });
    expect((await call('/relationship', 'GET', undefined, 'bob')).status).toBe(404);
    expect((await call('/relationship', 'DELETE', { version: 1 }, 'bob')).status).toBe(409);
    expect((await call('/relationship', 'PUT', draft, 'bob')).status).toBe(201);
    await env.DB.prepare('UPDATE users SET banned_at = 1 WHERE id = ?').bind('bob').run();
    expect((await call('/relationship', 'GET', undefined, 'bob')).status).toBe(403);
  });

  it('keeps one active relationship per character and uses CAS without changing its character', async () => {
    await call('/relationship', 'PUT', draft);
    expect((await call('/duplicate', 'PUT', draft)).status).toBe(409);
    expect(
      (await call('/relationship', 'PUT', { ...draft, version: 1, characterId: 'other' })).status,
    ).toBe(409);
    expect(
      (await call('/relationship', 'PUT', { ...draft, version: 1, aiNickname: '新的名字' })).status,
    ).toBe(200);
    expect((await call('/relationship', 'PUT', { ...draft, version: 1 })).status).toBe(409);
    expect(
      await (await call(`?characterId=${encodeURIComponent(draft.characterId)}`)).json(),
    ).toMatchObject({ items: [{ id: 'relationship', aiNickname: '新的名字', version: 2 }] });
    expect(await (await call('?characterId=other')).json()).toMatchObject({ items: [] });
  });

  it('erases private text on delete, rejects stale resurrection, and permits a new relationship identity', async () => {
    await call('/relationship', 'PUT', draft);
    expect((await call('/relationship', 'DELETE', { version: 2 })).status).toBe(409);
    expect((await call('/relationship', 'DELETE', { version: 1 })).status).toBe(200);
    expect((await call('/relationship')).status).toBe(404);
    expect((await call('/relationship', 'PUT', draft)).status).toBe(409);
    expect((await call('/relationship', 'PUT', { ...draft, version: 2 })).status).toBe(409);
    expect(
      await env.DB.prepare(
        'SELECT ai_nickname, user_preferred_name, relationship_type, notes, version FROM character_relationships WHERE user_id = ? AND id = ?',
      )
        .bind('alice', 'relationship')
        .first(),
    ).toEqual({
      ai_nickname: '',
      user_preferred_name: '',
      relationship_type: '',
      notes: '',
      version: 2,
    });
    expect((await call('/new-relationship', 'PUT', draft)).status).toBe(201);
  });

  it('rejects public/permission fields and invalid sizes and cascades account deletion', async () => {
    for (const extra of [
      { userId: 'bob' },
      { scope: 'group' },
      { permissions: ['devices'] },
      { characterName: '新公开名字' },
    ]) {
      expect((await call('/bad', 'PUT', { ...draft, ...extra })).status).toBe(400);
    }
    expect((await call('/bad', 'PUT', { ...draft, aiNickname: 'x'.repeat(81) })).status).toBe(400);
    expect((await call('/bad', 'PUT', { ...draft, notes: 'x'.repeat(4001) })).status).toBe(400);
    expect((await call('/bad', 'PUT', { ...draft, notes: 'x'.repeat(20_001) })).status).toBe(413);
    expect((await call('/bad', 'PUT', { ...draft, characterId: 'bad\n' })).status).toBe(400);
    await call('/relationship', 'PUT', draft);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind('alice').run();
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM character_relationships').first(),
    ).toEqual({ count: 0 });
  });

  it('caps active relationships without blocking edits or replacing existing personal names', async () => {
    for (let i = 0; i < 200; i++) {
      await env.DB.prepare(
        'INSERT INTO character_relationships (user_id,id,character_id,ai_nickname,user_preferred_name,relationship_type,notes,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1,1)',
      )
        .bind('alice', `r${i}`, `c${i}`, '私人名字', '', '', '')
        .run();
    }
    expect((await call('/overflow', 'PUT', draft)).status).toBe(409);
    expect((await call('/r0', 'PUT', { ...draft, characterId: 'c0', version: 1 })).status).toBe(
      200,
    );
  });
});

describe('per-relationship voice', () => {
  it('keeps the chosen voice across saves that omit it and clears it on delete', async () => {
    expect((await call('/r1', 'PUT', { ...draft, voice: 'ara' })).status).toBe(201);
    const updated = (await (
      await call('/r1', 'PUT', { ...draft, notes: '改了备注', version: 1 })
    ).json()) as { item: { voice: string; version: number } };
    expect(updated.item).toMatchObject({ voice: 'ara', version: 2 });
    const cleared = (await (
      await call('/r1', 'PUT', { ...draft, voice: '', version: 2 })
    ).json()) as {
      item: { voice: string };
    };
    expect(cleared.item.voice).toBe('');
    expect((await call('/r1', 'PUT', { ...draft, voice: 'bad voice!', version: 3 })).status).toBe(
      400,
    );
    expect((await call('/r1', 'DELETE', { version: 3 })).status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT voice FROM character_relationships WHERE id='r1'",
    ).first<{
      voice: string;
    }>();
    expect(row?.voice).toBe('');
  });
});
