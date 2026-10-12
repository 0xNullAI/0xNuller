import { expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStableObjectListing } from './chat-backup-consistency.mjs';
import { captureAuthMedia, captureChat } from './chat-backup.mjs';

test('postflight listing accepts identical objects in another page order', () => {
  expect(() =>
    assertStableObjectListing(
      [
        { key: 'a', size: 3, etag: 'x' },
        { key: 'b', size: 4, etag: 'y' },
      ],
      [
        { key: 'b', size: 4, etag: 'y' },
        { key: 'a', size: 3, etag: 'x' },
      ],
      ['size', 'etag'],
      'media',
    ),
  ).not.toThrow();
});

test('postflight listing rejects added, deleted and same-size replaced media', () => {
  const before = [{ key: 'private-key', size: 3, etag: 'old' }];
  for (const after of [
    [],
    [{ key: 'another-key', size: 3, etag: 'old' }],
    [{ key: 'private-key', size: 3, etag: 'new' }],
  ]) {
    expect(() => assertStableObjectListing(before, after, ['size', 'etag'], 'media')).toThrow(
      'media changed during export',
    );
  }
});

test('Auth capture aborts when an attachment changes after its bytes were read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auth-backup-consistency-test-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.AUTH_BACKUP_TOKEN;
  process.env.AUTH_BACKUP_TOKEN = 't'.repeat(40);
  const key = 'users/u1/conversations/c1/attachments/a1';
  let listing = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/list')) {
      listing++;
      return Response.json({
        objects: [{ key, size: 3, mime: listing === 1 ? 'image/png' : 'image/jpeg' }],
        cursor: null,
      });
    }
    if (route.endsWith('/content'))
      return new Response('abc', { headers: { 'X-Backup-Etag': 'etag-1' } });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureAuthMedia(
        'https://localhost',
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Auth attachment changed during export');
    expect(listing).toBe(2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.AUTH_BACKUP_TOKEN;
    else process.env.AUTH_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Auth capture detects a same-size replacement through the postflight ETag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auth-backup-etag-test-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.AUTH_BACKUP_TOKEN;
  process.env.AUTH_BACKUP_TOKEN = 't'.repeat(40);
  const key = 'users/u1/conversations/c1/attachments/a1';
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/list'))
      return Response.json({ objects: [{ key, size: 3, mime: 'image/png' }], cursor: null });
    if (route.endsWith('/content'))
      return new Response('abc', { headers: { 'X-Backup-Etag': 'old' } });
    if (route.endsWith('/head'))
      return Response.json({ key, size: 3, mime: 'image/png', etag: 'new' });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureAuthMedia(
        'https://localhost',
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Auth attachment changed during export');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.AUTH_BACKUP_TOKEN;
    else process.env.AUTH_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture aborts when an R2 object changes after its bytes were read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-etag-test-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, '["room-1"]');
  let listings = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages'))
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: [],
        before: null,
        totalMessages: 0,
      });
    if (route.endsWith('/media-list')) {
      listings++;
      return Response.json({
        objects: [
          {
            key: 'room/room-1/picture',
            size: 3,
            etag: listings === 1 ? 'old' : 'new',
            uploaded: '2026-01-01T00:00:00.000Z',
          },
        ],
        cursor: null,
      });
    }
    if (route.endsWith('/media'))
      return new Response('abc', { headers: { 'X-Backup-Etag': 'old' } });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Chat media changed during export');
    expect(listings).toBe(2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture rejects truncated media even when the response ETag matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-truncated-media-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, '["room-1"]');
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages'))
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: [],
        before: null,
        totalMessages: 0,
      });
    if (route.endsWith('/media-list'))
      return Response.json({
        objects: [{ key: 'room/room-1/picture', size: 3, etag: 'same', uploaded: '2026-01-01' }],
        cursor: null,
      });
    if (route.endsWith('/media'))
      return new Response('ab', { headers: { 'X-Backup-Etag': 'same' } });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Media changed during export');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture includes media belonging to a private DM room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-dm-media-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const room = `dm:${'a'.repeat(64)}`;
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, JSON.stringify([room]));
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages'))
      return Response.json({ room, exists: true, messages: [], before: null, totalMessages: 0 });
    if (route.endsWith('/media-list'))
      return Response.json({
        objects: [{ key: `room/${room}/picture`, size: 3, etag: 'same', uploaded: '2026-01-01' }],
        cursor: null,
      });
    if (route.endsWith('/media'))
      return new Response('abc', { headers: { 'X-Backup-Etag': 'same' } });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).resolves.toBeTruthy();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture aborts when room messages change while media is exported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-room-postflight-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, '["room-1"]');
  let mediaListed = false;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages'))
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: mediaListed ? [{ id: 'new', ts: 1, body: '{"x":"hello"}' }] : [],
        before: null,
        totalMessages: mediaListed ? 1 : 0,
      });
    if (route.endsWith('/media-list')) {
      mediaListed = true;
      return Response.json({ objects: [], cursor: null });
    }
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Room messages changed during export');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture aborts when an account deletion is recorded during export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-deletion-postflight-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, '["room-1"]');
  let deletionScans = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones'))
      return Response.json({
        accounts:
          ++deletionScans === 1
            ? []
            : [{ account_id: 'account-1', deletion_id: 'job-1', deleted_at: 1 }],
        cursor: null,
      });
    if (route.endsWith('/messages'))
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: [],
        before: null,
        totalMessages: 0,
      });
    if (route.endsWith('/media-list')) return Response.json({ objects: [], cursor: null });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Account deletion tombstone changed during export');
    expect(deletionScans).toBe(2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('indexed Chat capture aborts when a room is tombstoned during export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-index-postflight-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  let indexScans = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/rooms')) {
      indexScans++;
      return Response.json({
        rooms: [
          {
            code: 'room-1',
            kind: 'group',
            source: 'admission',
            deleted_at: indexScans === 1 ? null : 1,
            deletion_reason: indexScans === 1 ? null : 'closed',
          },
        ],
        cursor: null,
        coverage: 'observed-and-explicit-hints',
      });
    }
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages'))
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: [],
        before: null,
        totalMessages: 0,
      });
    if (route.endsWith('/media-list')) return Response.json({ objects: [], cursor: null });
    throw new Error('Unexpected backup route');
  };
  try {
    await expect(
      captureChat(
        'https://localhost',
        '--index',
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).rejects.toThrow('Chat room index changed during export');
    expect(indexScans).toBe(2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('Chat capture accepts an unchanged room after the media postflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-room-stable-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CHAT_BACKUP_TOKEN;
  process.env.CHAT_BACKUP_TOKEN = 't'.repeat(40);
  const roomsFile = join(root, 'rooms.json');
  await writeFile(roomsFile, '["room-1"]');
  let messageScans = 0;
  globalThis.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/account-tombstones')) return Response.json({ accounts: [], cursor: null });
    if (route.endsWith('/messages')) {
      messageScans++;
      return Response.json({
        room: 'room-1',
        exists: true,
        messages: [{ id: 'm1', ts: 1, body: '{"x":"hello"}' }],
        before: null,
        totalMessages: 1,
      });
    }
    if (route.endsWith('/media-list')) return Response.json({ objects: [], cursor: null });
    throw new Error('Unexpected backup route');
  };
  try {
    expect(
      await captureChat(
        'https://localhost',
        roomsFile,
        join(root, 'bundle'),
        'long isolated consistency test passphrase',
      ),
    ).toMatchObject({ files: 3 });
    expect(messageScans).toBe(3);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CHAT_BACKUP_TOKEN;
    else process.env.CHAT_BACKUP_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});
