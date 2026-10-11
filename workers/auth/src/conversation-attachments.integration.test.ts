import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './test-helpers';
import { sha256Hex } from './session-domain';
import {
  handleConversationAttachments,
  runConversationAttachmentCleanup,
} from './conversation-attachments';
import { handleServerConversations } from './server-conversations';
import { VALID_PNG } from './test-image';

let db: ReturnType<typeof createTestDb>;
let env: Parameters<typeof handleConversationAttachments>[1];
let objects: Map<string, Uint8Array>;
beforeEach(async () => {
  db = createTestDb();
  objects = new Map();
  env = {
    DB: db.DB,
    PHOTOS: {
      put: async (key: string, data: Uint8Array) => {
        objects.set(key, data);
      },
      get: async (key: string) =>
        objects.has(key) ? { body: new Blob([Uint8Array.from(objects.get(key)!)]).stream() } : null,
      delete: async (key: string) => {
        objects.delete(key);
      },
    },
  } as unknown as typeof env;
  for (const id of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,1)',
    )
      .bind(id, id, id, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,1,?)',
    )
      .bind(await sha256Hex(id), id, Date.now() + 60_000)
      .run();
  }
  const created = await handleServerConversations(
    new Request('https://test/api/auth/conversations/s', {
      method: 'PUT',
      headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      body: JSON.stringify({
        expectedRevision: 0,
        session: {
          id: 's',
          createdAt: 1,
          updatedAt: 1,
          messages: [],
          metadata: { promptPresetId: 'character' },
        },
      }),
    }),
    env,
    {},
  );
  expect(created?.status).toBe(201);
});
afterEach(() => db.close());

function call(path: string, method = 'GET', body?: Blob, user = 'alice', account = user) {
  return handleConversationAttachments(
    new Request(`https://test/api/auth/conversations${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        'X-Account-Id': account,
        ...(body ? { 'Content-Type': body.type } : {}),
      },
      body,
    }),
    env,
    {},
  );
}

function conversation(
  path: string,
  method = 'GET',
  body?: unknown,
  user = 'alice',
  account = user,
) {
  return handleServerConversations(
    new Request(`https://test/api/auth/conversations${path}`, {
      method,
      headers: { Authorization: `Bearer ${user}`, 'X-Account-Id': account },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    {},
  );
}

describe('private AI conversation attachments', () => {
  it('restores one server timeline across pages while isolating accounts and retrying a stale write', async () => {
    const initial = Array.from({ length: 25 }, (_, index) => ({
      id: `text-${index}`,
      role: 'user',
      content: `Message ${index}`,
      createdAt: index + 1,
    }));
    expect(
      (
        await conversation('/s/messages', 'POST', {
          expectedRevision: 1,
          messages: initial.slice(0, 20),
        })
      )?.status,
    ).toBe(200);
    expect(
      (
        await conversation('/s/messages', 'POST', {
          expectedRevision: 2,
          messages: initial.slice(20),
        })
      )?.status,
    ).toBe(200);

    const upload = await call(
      '/s/attachments',
      'POST',
      new Blob([VALID_PNG], { type: 'image/png' }),
    );
    expect(upload?.status).toBe(201);
    const attachment = ((await upload!.json()) as { attachment: { id: string } }).attachment;
    expect((await call(`/s/attachments/${attachment.id}/content`))?.status).toBe(404);
    expect((await call(`/s/attachments/${attachment.id}/commit`, 'POST'))?.status).toBe(201);
    expect((await call(`/s/attachments/${attachment.id}/commit`, 'POST'))?.status).toBe(200);

    const late = { id: 'late', role: 'assistant', content: 'I saw your photo', createdAt: 30 };
    expect(
      (
        await conversation('/s/messages', 'POST', {
          expectedRevision: 3,
          messages: [late],
        })
      )?.status,
    ).toBe(409);
    const restored = await conversation('/s?window=20');
    expect(restored?.status).toBe(200);
    const current = (await restored!.json()) as {
      revision: number;
      session: { messages: Array<{ id: string }> };
    };
    expect(current.session.messages).toHaveLength(20);
    expect(current.session.messages.at(-1)?.id).toBe(`attachment-${attachment.id}`);
    expect(
      (
        await conversation('/s/messages', 'POST', {
          expectedRevision: current.revision,
          messages: [late],
        })
      )?.status,
    ).toBe(200);
    expect(
      (
        await conversation('/s/messages', 'POST', {
          expectedRevision: current.revision,
          messages: [late],
        })
      )?.status,
    ).toBe(200);

    const ids: string[] = [];
    let before: number | null = null;
    do {
      const pageResponse = await conversation(
        `/s/messages?limit=7${before ? `&before=${before}` : ''}`,
      );
      expect(pageResponse?.status).toBe(200);
      const page = (await pageResponse!.json()) as {
        items: Array<{ id: string; sequence: number }>;
        nextBefore: number | null;
      };
      ids.unshift(...page.items.map((item) => item.id));
      before = page.nextBefore;
    } while (before !== null);
    expect(ids).toEqual([...initial.map((item) => item.id), `attachment-${attachment.id}`, 'late']);
    expect(new Set(ids).size).toBe(ids.length);

    expect((await conversation('/s/messages', 'GET', undefined, 'alice', 'bob'))?.status).toBe(403);
    expect(
      (await call(`/s/attachments/${attachment.id}/content`, 'GET', undefined, 'alice', 'bob'))
        ?.status,
    ).toBe(403);
    expect((await conversation('/s/messages', 'GET', undefined, 'bob'))?.status).toBe(404);
    expect(
      (await call(`/s/attachments/${attachment.id}/content`, 'GET', undefined, 'bob'))?.status,
    ).toBe(404);
    expect(
      (
        await conversation(
          '/s',
          'PUT',
          {
            expectedRevision: 0,
            session: {
              id: 's',
              createdAt: 1,
              updatedAt: 1,
              messages: [],
              metadata: { promptPresetId: 'other' },
            },
          },
          'bob',
        )
      )?.status,
    ).toBe(201);
    expect((await conversation('/s/messages', 'GET', undefined, 'bob'))?.status).toBe(200);
    expect((await call('/s/attachments', 'GET', undefined, 'bob'))?.status).toBe(200);
    expect(
      (
        (await (await call('/s/attachments', 'GET', undefined, 'bob'))!.json()) as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);
    expect((await call(`/s/attachments/${attachment.id}/content`))?.status).toBe(200);
  });
  it('commits a private image and voice message; summary exposes only type', async () => {
    const image = await call(
      '/s/attachments',
      'POST',
      new Blob([VALID_PNG], { type: 'image/png' }),
    );
    expect(image?.status).toBe(201);
    const first = ((await image!.json()) as { attachment: { id: string; messageId: string } })
      .attachment;
    expect(first.messageId).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT last_message_at FROM server_conversations WHERE user_id='alice' AND id='s'",
        ).first<{ last_message_at: number | null }>()
      )?.last_message_at,
    ).toBeNull();
    expect((await call(`/s/attachments/${first.id}/content`))?.status).toBe(404);
    expect((await call(`/s/attachments/${first.id}/commit`, 'POST'))?.status).toBe(201);
    const firstMessageAt = (
      await env.DB.prepare(
        "SELECT last_message_at FROM server_conversations WHERE user_id='alice' AND id='s'",
      ).first<{ last_message_at: number | null }>()
    )?.last_message_at;
    expect(firstMessageAt).toBeGreaterThan(0);
    expect((await call(`/s/attachments/${first.id}/content`))?.status).toBe(200);
    expect(
      (await call(`/s/attachments/${first.id}/content`, 'GET', undefined, 'bob'))?.status,
    ).toBe(404);
    const voice = await call(
      '/s/attachments',
      'POST',
      new Blob([Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0)], { type: 'audio/ogg' }),
    );
    expect(voice?.status).toBe(201);
    const voiceId = ((await voice!.json()) as { attachment: { id: string } }).attachment.id;
    expect((await call(`/s/attachments/${voiceId}/commit`, 'POST'))?.status).toBe(201);
    const list = await call('/s/attachments');
    expect(((await list!.json()) as { items: unknown[] }).items).toHaveLength(2);
    const summary = await handleServerConversations(
      new Request('https://test/api/auth/conversations?summary=1', {
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
      }),
      env,
      {},
    );
    expect(
      ((await summary!.json()) as { items: Array<{ preview: string; lastMessageAt: number }> })
        .items[0]?.preview,
    ).toBe('[语音]');
    expect(objects.size).toBe(2);
  });

  it('commits user-confirmed voice text with the clip and rejects invalid captions', async () => {
    const voice = await call(
      '/s/attachments',
      'POST',
      new Blob([Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0)], { type: 'audio/ogg' }),
    );
    const id = ((await voice!.json()) as { attachment: { id: string } }).attachment.id;
    expect(
      (
        await call(
          `/s/attachments/${id}/commit`,
          'POST',
          new Blob(['{"caption":42}'], { type: 'application/json' }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await call(
          `/s/attachments/${id}/commit`,
          'POST',
          new Blob([JSON.stringify({ caption: 'x'.repeat(2001) })], { type: 'application/json' }),
        )
      )?.status,
    ).toBe(400);
    const committed = await call(
      `/s/attachments/${id}/commit`,
      'POST',
      new Blob([JSON.stringify({ caption: '今晚想聊聊小猫' })], { type: 'application/json' }),
    );
    expect(committed?.status).toBe(201);
    expect(
      ((await committed!.json()) as { attachment: { caption: string } }).attachment.caption,
    ).toBe('今晚想聊聊小猫');
    const listed = await call('/s/attachments');
    expect(
      ((await listed!.json()) as { items: Array<{ caption: string }> }).items[0]?.caption,
    ).toBe('今晚想聊聊小猫');
    const messages = await conversation('/s/messages');
    expect(
      ((await messages!.json()) as { items: Array<{ content: string }> }).items.at(-1)?.content,
    ).toContain('用户为语音附上的文字（未自动核对音频）：今晚想聊聊小猫');
    // Repeated commits cannot change an already-confirmed message.
    expect(
      (
        await call(
          `/s/attachments/${id}/commit`,
          'POST',
          new Blob([JSON.stringify({ caption: '篡改' })], { type: 'application/json' }),
        )
      )?.status,
    ).toBe(200);
    const after = await conversation('/s/messages');
    expect(
      ((await after!.json()) as { items: Array<{ content: string }> }).items.at(-1)?.content,
    ).toContain('今晚想聊聊小猫');
  });

  it('rejects wrong account, conversation and malformed contents', async () => {
    expect(
      (
        await call(
          '/s/attachments',
          'POST',
          new Blob([VALID_PNG], { type: 'image/png' }),
          'alice',
          'bob',
        )
      )?.status,
    ).toBe(403);
    expect(
      (await call('/missing/attachments', 'POST', new Blob([VALID_PNG], { type: 'image/png' })))
        ?.status,
    ).toBe(404);
    expect(
      (await call('/s/attachments', 'POST', new Blob(['not png'], { type: 'image/png' })))?.status,
    ).toBe(400);
    expect(
      (await call('/s/attachments', 'POST', new Blob(['not voice'], { type: 'audio/ogg' })))
        ?.status,
    ).toBe(400);
    expect(objects.size).toBe(0);
  });

  it('keeps staged bytes hidden until a same-account commit', async () => {
    const upload = await call(
      '/s/attachments',
      'POST',
      new Blob([VALID_PNG], { type: 'image/png' }),
    );
    const id = ((await upload!.json()) as { attachment: { id: string } }).attachment.id;
    expect(
      ((await call('/s/attachments')?.then((response) => response?.json())) as { items: unknown[] })
        .items,
    ).toEqual([]);
    expect(
      (await call(`/s/attachments/${id}/commit`, 'POST', undefined, 'alice', 'bob'))?.status,
    ).toBe(403);
    expect((await call(`/s/attachments/${id}/commit`, 'POST', undefined, 'bob'))?.status).toBe(404);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM server_conversation_messages',
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect((await call(`/s/attachments/${id}/commit`, 'POST'))?.status).toBe(201);
    expect((await call(`/s/attachments/${id}/commit`, 'POST'))?.status).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM server_conversation_messages').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });

  it('makes content inaccessible after conversation deletion and retries R2 cleanup', async () => {
    const upload = await call(
      '/s/attachments',
      'POST',
      new Blob([VALID_PNG], { type: 'image/png' }),
    );
    const id = ((await upload!.json()) as { attachment: { id: string } }).attachment.id;
    expect((await call(`/s/attachments/${id}/commit`, 'POST'))?.status).toBe(201);
    const deleted = await handleServerConversations(
      new Request('https://test/api/auth/conversations/s', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer alice', 'X-Account-Id': 'alice' },
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
      env,
      {},
    );
    expect(deleted?.status).toBe(200);
    expect((await call(`/s/attachments/${id}/content`))?.status).toBe(404);
    expect(objects.size).toBe(1);
    await runConversationAttachmentCleanup(env);
    expect(objects.size).toBe(0);
  });

  it('purges abandoned uploads without creating a conversation message', async () => {
    const upload = await call(
      '/s/attachments',
      'POST',
      new Blob([VALID_PNG], { type: 'image/png' }),
    );
    expect(upload?.status).toBe(201);
    await env.DB.prepare(
      "UPDATE private_conversation_attachments SET created_at=? WHERE status='pending'",
    )
      .bind(Date.now() - 25 * 60 * 60 * 1000)
      .run();
    await runConversationAttachmentCleanup(env);
    expect(objects.size).toBe(0);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM server_conversation_messages').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
});
