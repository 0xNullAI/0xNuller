import { expect, it } from 'vitest';
import worker from './index';
import { env, post, prepared, req, seedUser, useAuthWorkerTestEnv } from './index.test-support';
import { createTestDb } from './test-helpers';

useAuthWorkerTestEnv(createTestDb);

it('answers malformed and oversized JSON bodies with 400/413 instead of 500', async () => {
  const { token } = await seedUser('alice');
  const put = (path: string, body: string) =>
    worker.fetch(req(path, { method: 'PUT', token, body }), env);
  expect((await put('/api/auth/profile', '{not json')).status).toBe(400);
  expect((await put('/api/auth/profile', 'null')).status).toBe(400);
  expect((await put('/api/auth/settings/ui', '{"payload":')).status).toBe(400);
  expect((await put('/api/auth/agent-sessions', '[')).status).toBe(400);
  expect((await put('/api/auth/content', '')).status).toBe(400);
  const huge = JSON.stringify({ bio: 'x'.repeat(300 * 1024) });
  expect((await put('/api/auth/profile', huge)).status).toBe(413);
});

it('answers an undecodable path segment with 400 instead of 500', async () => {
  const { token } = await seedUser('alice');
  const response = await worker.fetch(req('/api/auth/users/%E0%A4%A', { token }), env);
  expect(response.status).toBe(400);
});

it('lets the open-report unique index settle concurrent duplicate reports', async () => {
  const alice = await seedUser('alice');
  const bob = await seedUser('bob');
  const statuses = (
    await Promise.all(
      [1, 2].map(() =>
        post('/api/auth/report', { userId: bob.id, reason: 'spam' }, { token: alice.token }),
      ),
    )
  )
    .map((response) => response.status)
    .sort();
  expect(statuses).toEqual([200, 201]);
  expect((await prepared('SELECT COUNT(*) AS n FROM user_reports').first<{ n: number }>())?.n).toBe(
    1,
  );
});
