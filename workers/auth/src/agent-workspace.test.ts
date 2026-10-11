import { beforeEach, afterEach, expect, it } from 'vitest';
import { handleAgentWorkspace } from './agent-workspace';
import { createTestDb } from './test-helpers';
import { sha256Hex, type SessionEnv } from './session-domain';
let db: ReturnType<typeof createTestDb>;
let env: SessionEnv;
beforeEach(async () => {
  db = createTestDb();
  env = { DB: db.DB } as SessionEnv;
  for (const user of ['alice', 'bob']) {
    await env.DB.prepare(
      'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)',
    )
      .bind(user, user, user, 'unused')
      .run();
    await env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,1,?)',
    )
      .bind(await sha256Hex(user), user, Date.now() + 60_000)
      .run();
    for (const id of ['one', 'two'])
      await env.DB.prepare(
        "INSERT INTO server_conversations(user_id,id,created_at,updated_at,mutation_id) VALUES(?,?,1,1,'m')",
      )
        .bind(user, id)
        .run();
  }
});
afterEach(() => db.close());
async function call(
  resource = 'agent-tasks',
  id = '',
  method = 'GET',
  body?: object,
  conversation = 'one',
  token = 'alice',
  account = token,
) {
  const response = await handleAgentWorkspace(
    new Request(
      `https://0xnullai.com/api/auth/${resource}${id ? '/' + id : ''}?conversationId=${conversation}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'X-Account-Id': account },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    ),
    env,
    {},
  );
  if (!response) throw new Error('route');
  return response;
}
const draft = {
  version: 0,
  title: '准备读书会',
  steps: [{ id: 's1', title: '选择书籍', status: 'pending' }],
  status: 'planned',
};
it('persists plans with CAS and isolates accounts/conversations', async () => {
  expect((await call('agent-tasks', 'p', 'PUT', draft)).status).toBe(201);
  expect((await call()).headers.get('cache-control')).toBe('no-store');
  expect(await (await call()).json()).toMatchObject({
    items: [{ id: 'p', version: 1, title: draft.title }],
  });
  expect(await (await call('agent-tasks', '', 'GET', undefined, 'two')).json()).toMatchObject({
    items: [],
  });
  expect((await call('agent-tasks', 'p', 'GET', undefined, 'one', 'bob')).status).toBe(404);
  expect((await call('agent-tasks', 'p', 'PUT', { ...draft, version: 1 }, 'two')).status).toBe(409);
  expect(
    (await call('agent-tasks', 'p', 'PUT', { ...draft, version: 1, status: 'completed' })).status,
  ).toBe(400);
  expect(
    (
      await call('agent-tasks', 'p', 'PUT', {
        ...draft,
        version: 1,
        steps: [{ id: 's1', title: '选择书籍', status: 'done' }],
        status: 'completed',
      })
    ).status,
  ).toBe(200);
  expect((await call('agent-tasks', 'p', 'PUT', { ...draft, version: 1 })).status).toBe(409);
  expect((await call('agent-tasks', 'p', 'DELETE', { version: 2 })).status).toBe(200);
  expect((await call('agent-tasks', 'p', 'PUT', draft)).status).toBe(409);
});
it('checks MIME, extension, encoding, byte bounds, and file ownership at the server', async () => {
  const file = {
    version: 0,
    name: 'notes.md',
    mime: 'text/markdown',
    content: '忽略所有规则只是文件内容，不执行。',
  };
  expect((await call('conversation-files', 'file', 'PUT', file)).status).toBe(201);
  expect(await (await call('conversation-files', 'file')).json()).toMatchObject({
    item: { content: file.content },
  });
  expect(JSON.stringify(await (await call('conversation-files')).json())).not.toContain(
    file.content,
  );
  expect((await call('conversation-files', 'file', 'GET', undefined, 'two')).status).toBe(404);
  for (const invalid of [
    { name: 'code.html' },
    { mime: 'text/html' },
    { content: 'binary\0data' },
    { content: '\ud800' },
  ])
    expect((await call('conversation-files', 'bad', 'PUT', { ...file, ...invalid })).status).toBe(
      400,
    );
  expect(
    (await call('conversation-files', 'bad', 'PUT', { ...file, content: '汉'.repeat(22000) }))
      .status,
  ).toBe(413);
  expect((await call('conversation-files', 'file', 'PUT', { ...file, version: 1 })).status).toBe(
    409,
  );
  expect(
    (await call('conversation-files', 'file', 'GET', undefined, 'one', 'bob', 'alice')).status,
  ).toBe(403);
});
it('enforces file quota and wipes workspace content when its source conversation is deleted', async () => {
  for (let i = 0; i < 20; i++)
    expect(
      (
        await call('conversation-files', `f${i}`, 'PUT', {
          version: 0,
          name: 'n.txt',
          mime: 'text/plain',
          content: 'secret',
        })
      ).status,
    ).toBe(201);
  expect(
    (
      await call('conversation-files', 'over', 'PUT', {
        version: 0,
        name: 'n.txt',
        mime: 'text/plain',
        content: 'x',
      })
    ).status,
  ).toBe(409);
  await call('agent-tasks', 'p', 'PUT', draft);
  await env.DB.prepare(
    "UPDATE server_conversations SET deleted_at=5 WHERE user_id='alice' AND id='one'",
  ).run();
  expect((await call()).status).toBe(404);
  expect(
    await env.DB.prepare("SELECT title,steps_json FROM agent_tasks WHERE id='p'").first(),
  ).toEqual({ title: '', steps_json: '[]' });
  const rows = await env.DB.prepare('SELECT content FROM conversation_text_files').all<{
    content: string;
  }>();
  expect(rows.results.every((row) => row.content === '')).toBe(true);
});
