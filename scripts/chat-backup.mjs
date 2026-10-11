import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatBackupBundle, verifyChatBackupBundle } from './chat-backup-bundle.mjs';
import { exerciseChatBackup } from './chat-backup-exercise.mjs';
import {
  assertRoomMessagesUnchanged,
  captureConsistentRoomMessages,
} from './chat-backup-room-export.mjs';
import { assertStableObjectListing } from './chat-backup-consistency.mjs';
import { captureChatBackupBatch, verifyChatBackupBatch } from './chat-backup-batch.mjs';
import { auditHistoricalRoomBundle } from './chat-backup-history-audit.mjs';
import { runScheduledChatBackup } from './chat-backup-scheduled.mjs';
import { assertAuthD1ChatTablesStable } from './chat-backup-d1-stability.mjs';

function usage() {
  throw new Error(
    'Usage: chat-backup.mjs pack <source-dir> <backup-dir> | verify <backup-dir> | restore <backup-dir> <empty-dir> | exercise <d1-bundle> <chat-bundle> <auth-media-bundle> | audit-history <chat-bundle> <independent-rooms-json> | capture-d1 <backup-dir> --local|--remote | capture-chat <https-endpoint> <rooms-json|--index> <backup-dir> | capture-auth-media <https-endpoint> <backup-dir> | capture-batch <auth-endpoint> <chat-endpoint> <rooms-json|--index> <batch-dir> --remote | capture-scheduled <auth-endpoint> <chat-endpoint> <independent-rooms-json> <backup-root> --remote | verify-batch <batch-dir>',
  );
}

async function backupRequest(
  endpoint,
  route,
  body,
  binary = false,
  tokenName = 'CHAT_BACKUP_TOKEN',
) {
  const token = process.env[tokenName];
  if (!token || token.length < 32) throw new Error(`Set ${tokenName} outside the repository`);
  const url = new URL(route, endpoint);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
    throw new Error('Backup API requires HTTPS');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Chat export failed (${response.status})`);
  return binary
    ? {
        data: Buffer.from(await response.arrayBuffer()),
        etag: response.headers.get('X-Backup-Etag'),
      }
    : response.json();
}

async function listBackupObjects(endpoint, route, tokenName) {
  const objects = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await backupRequest(
      endpoint,
      route,
      tokenName === 'AUTH_BACKUP_TOKEN' ? { after: cursor } : { cursor },
      false,
      tokenName,
    );
    if (!Array.isArray(page.objects)) throw new Error('Invalid backup object listing');
    objects.push(...page.objects);
    cursor = page.cursor ?? undefined;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor)))
      throw new Error('Invalid backup object cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return objects;
}

async function listIndexedRooms(endpoint) {
  const rooms = [];
  const seenCursors = new Set();
  let after;
  do {
    const page = await backupRequest(endpoint, '/api/groups/backup/rooms', { after });
    if (page.coverage !== 'observed-and-explicit-hints' || !Array.isArray(page.rooms))
      throw new Error('Invalid room index listing');
    rooms.push(...page.rooms);
    after = page.cursor ?? undefined;
    if (after && (typeof after !== 'string' || seenCursors.has(after)))
      throw new Error('Invalid room index cursor');
    if (after) seenCursors.add(after);
  } while (after);
  return rooms;
}

export async function captureAuthMedia(endpoint, destination, passphrase) {
  const temporary = await mkdtemp(join(tmpdir(), '0xnullai-auth-media-export-'));
  const keyPattern =
    /^users\/[A-Za-z0-9._:-]{1,128}\/conversations\/[A-Za-z0-9._:-]{1,128}\/attachments\/[A-Za-z0-9._:-]{1,128}$/;
  try {
    await mkdir(join(temporary, 'objects'));
    const objects = [];
    const seen = new Set();
    let after;
    do {
      const page = await backupRequest(
        endpoint,
        '/api/auth/backup/attachments/list',
        { after },
        false,
        'AUTH_BACKUP_TOKEN',
      );
      if (!Array.isArray(page.objects)) throw new Error('Invalid Auth attachment listing');
      for (const item of page.objects) {
        if (
          typeof item.key !== 'string' ||
          !keyPattern.test(item.key) ||
          seen.has(item.key) ||
          !Number.isSafeInteger(item.size) ||
          item.size <= 0 ||
          typeof item.mime !== 'string'
        )
          throw new Error('Invalid or duplicate Auth attachment');
        seen.add(item.key);
        const content = await backupRequest(
          endpoint,
          '/api/auth/backup/attachments/content',
          { key: item.key },
          true,
          'AUTH_BACKUP_TOKEN',
        );
        if (content.data.byteLength !== item.size || !content.etag)
          throw new Error('Auth attachment changed during export');
        const file = `${String(objects.length).padStart(8, '0')}.bin`;
        await writeFile(join(temporary, 'objects', file), content.data, { flag: 'wx' });
        objects.push({ key: item.key, size: item.size, mime: item.mime, etag: content.etag, file });
      }
      after = page.cursor ?? undefined;
      if (
        after &&
        (typeof after !== 'string' || !keyPattern.test(after) || seen.has(`cursor:${after}`))
      )
        throw new Error('Invalid Auth attachment cursor');
      if (after) seen.add(`cursor:${after}`);
    } while (after);
    const postflight = await listBackupObjects(
      endpoint,
      '/api/auth/backup/attachments/list',
      'AUTH_BACKUP_TOKEN',
    );
    assertStableObjectListing(objects, postflight, ['size', 'mime'], 'Auth attachment');
    for (const item of objects) {
      const head = await backupRequest(
        endpoint,
        '/api/auth/backup/attachments/head',
        { key: item.key },
        false,
        'AUTH_BACKUP_TOKEN',
      );
      if (
        head.key !== item.key ||
        head.size !== item.size ||
        head.mime !== item.mime ||
        head.etag !== item.etag
      )
        throw new Error('Auth attachment changed during export');
    }
    await writeFile(
      join(temporary, 'attachments.json'),
      JSON.stringify({
        kind: 'auth-private-ai-attachments',
        count: objects.length,
        objects,
        consistency: 'cross-service-unverified',
      }),
      { flag: 'wx' },
    );
    const result = await createChatBackupBundle(temporary, destination, passphrase);
    await verifyChatBackupBundle(destination, passphrase);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function captureChat(endpoint, roomsFile, destination, passphrase) {
  let enumeration = 'operator-supplied-only';
  let rooms;
  let roomIndex = [];
  if (roomsFile === '--index') {
    enumeration = 'observed-and-explicit-hints';
    roomIndex = await listIndexedRooms(endpoint);
    rooms = roomIndex.map((row) => row.code);
  } else rooms = JSON.parse(await readFile(roomsFile, 'utf8'));
  if (
    !Array.isArray(rooms) ||
    rooms.length === 0 ||
    rooms.some((room) => typeof room !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(room)) ||
    new Set(rooms).size !== rooms.length
  )
    throw new Error('Rooms file must contain unique room codes');
  const temporary = await mkdtemp(join(tmpdir(), '0xnullai-chat-export-'));
  try {
    await mkdir(join(temporary, 'rooms'));
    await mkdir(join(temporary, 'media'));
    if (roomIndex.length)
      await writeFile(join(temporary, 'room-index.json'), JSON.stringify(roomIndex), {
        flag: 'wx',
      });
    let accountAfter;
    const accountCursors = new Set();
    const accountTombstones = [];
    do {
      const page = await backupRequest(endpoint, '/api/groups/backup/account-tombstones', {
        after: accountAfter,
      });
      if (!Array.isArray(page.accounts)) throw new Error('Invalid account deletion listing');
      accountTombstones.push(...page.accounts);
      accountAfter = page.cursor ?? undefined;
      if (accountAfter && (typeof accountAfter !== 'string' || accountCursors.has(accountAfter)))
        throw new Error('Invalid account deletion cursor');
      if (accountAfter) accountCursors.add(accountAfter);
    } while (accountAfter);
    await writeFile(join(temporary, 'account-tombstones.json'), JSON.stringify(accountTombstones), {
      flag: 'wx',
    });
    for (const room of rooms) {
      const messages = await captureConsistentRoomMessages(room, (code, before) =>
        backupRequest(endpoint, '/api/groups/backup/messages', { room: code, before }),
      );
      await writeFile(
        join(temporary, 'rooms', `${encodeURIComponent(room)}.json`),
        JSON.stringify(messages),
        { flag: 'wx' },
      );
    }
    let cursor;
    const seen = new Set();
    const media = [];
    do {
      const page = await backupRequest(endpoint, '/api/groups/backup/media-list', { cursor });
      if (!Array.isArray(page.objects)) throw new Error('Invalid media listing');
      for (const item of page.objects) {
        if (
          typeof item.key !== 'string' ||
          !/^room\/[A-Za-z0-9._:-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(item.key) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0 ||
          typeof item.etag !== 'string' ||
          !item.etag ||
          seen.has(item.key)
        )
          throw new Error('Invalid or duplicate media key');
        seen.add(item.key);
        const contents = await backupRequest(
          endpoint,
          '/api/groups/backup/media',
          { key: item.key },
          true,
        );
        if (contents.etag !== item.etag || contents.data.byteLength !== item.size)
          throw new Error('Media changed during export');
        const filename = `${media.length.toString().padStart(8, '0')}.bin`;
        await writeFile(join(temporary, 'media', filename), contents.data, { flag: 'wx' });
        media.push({ ...item, file: filename });
      }
      cursor = page.cursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || seen.has(`cursor:${cursor}`)))
        throw new Error('Invalid media listing cursor');
      if (cursor) seen.add(`cursor:${cursor}`);
    } while (cursor);
    const postflight = await listBackupObjects(
      endpoint,
      '/api/groups/backup/media-list',
      'CHAT_BACKUP_TOKEN',
    );
    assertStableObjectListing(media, postflight, ['size', 'etag', 'uploaded'], 'Chat media');
    for (const room of rooms) {
      const captured = JSON.parse(
        await readFile(join(temporary, 'rooms', `${encodeURIComponent(room)}.json`), 'utf8'),
      );
      await assertRoomMessagesUnchanged(room, captured, (code, before) =>
        backupRequest(endpoint, '/api/groups/backup/messages', { room: code, before }),
      );
    }
    const currentAccountTombstones = [];
    accountAfter = undefined;
    accountCursors.clear();
    do {
      const page = await backupRequest(endpoint, '/api/groups/backup/account-tombstones', {
        after: accountAfter,
      });
      if (!Array.isArray(page.accounts)) throw new Error('Invalid account deletion listing');
      currentAccountTombstones.push(...page.accounts);
      accountAfter = page.cursor ?? undefined;
      if (accountAfter && (typeof accountAfter !== 'string' || accountCursors.has(accountAfter)))
        throw new Error('Invalid account deletion cursor');
      if (accountAfter) accountCursors.add(accountAfter);
    } while (accountAfter);
    assertStableObjectListing(
      accountTombstones.map((item) => ({ ...item, key: item.account_id })),
      currentAccountTombstones.map((item) => ({ ...item, key: item.account_id })),
      ['deletion_id', 'deleted_at'],
      'Account deletion tombstone',
    );
    if (roomsFile === '--index') {
      const currentRoomIndex = await listIndexedRooms(endpoint);
      assertStableObjectListing(
        roomIndex.map((item) => ({ ...item, key: item.code })),
        currentRoomIndex.map((item) => ({ ...item, key: item.code })),
        ['kind', 'source', 'deleted_at', 'deletion_reason'],
        'Chat room index',
      );
    }
    await writeFile(
      join(temporary, 'coverage.json'),
      JSON.stringify({
        rooms: rooms.length,
        mediaCount: media.length,
        roomEnumeration: enumeration,
        historicalCoverage: 'unverified',
        accountTombstones: accountTombstones.length,
        mediaEnumeration: 'all-current-R2-objects',
        media,
      }),
      { flag: 'wx' },
    );
    const result = await createChatBackupBundle(temporary, destination, passphrase);
    await verifyChatBackupBundle(destination, passphrase);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function exportD1(folder, location) {
  const binary = resolve('node_modules/.bin/wrangler');
  const args = [
    'd1',
    'export',
    '0xnullai-auth',
    location,
    '--config',
    'workers/auth/wrangler.jsonc',
    '--output',
    join(folder, 'auth-d1.sql'),
  ];
  await new Promise((resolveDone, reject) => {
    const process = spawn(binary, args, { stdio: 'inherit', shell: false });
    process.once('error', reject);
    process.once('exit', (code) =>
      code === 0 ? resolveDone() : reject(new Error(`D1 export failed (${code})`)),
    );
  });
}

export async function captureD1(destination, location, passphrase) {
  const temporary = await mkdtemp(join(tmpdir(), '0xnullai-d1-export-'));
  try {
    await exportD1(temporary, location);
    const result = await createChatBackupBundle(temporary, destination, passphrase);
    await verifyChatBackupBundle(destination, passphrase);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function checkD1Postflight(firstBundle, passphrase) {
  const temporary = await mkdtemp(join(tmpdir(), '0xnullai-d1-postflight-'));
  try {
    const first = join(temporary, 'first');
    const last = join(temporary, 'last');
    await verifyChatBackupBundle(firstBundle, passphrase, first);
    await mkdir(last, { mode: 0o700 });
    await exportD1(last, '--remote');
    return await assertAuthD1ChatTablesStable(
      join(first, 'auth-d1.sql'),
      join(last, 'auth-d1.sql'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const [command, first, second, third, fourth, fifth] = process.argv.slice(2);
  const passphrase = process.env.CHAT_BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error('Set CHAT_BACKUP_PASSPHRASE outside the repository');
  let result;
  if (command === 'pack' && first && second && !third) {
    result = await createChatBackupBundle(first, second, passphrase);
  } else if (command === 'verify' && first && !second) {
    result = await verifyChatBackupBundle(first, passphrase);
  } else if (command === 'restore' && first && second && !third) {
    result = await verifyChatBackupBundle(first, passphrase, second);
  } else if (command === 'exercise' && first && second && third && !fourth) {
    result = await exerciseChatBackup(first, second, third, passphrase);
    if (!result.passed) process.exitCode = 1;
  } else if (command === 'audit-history' && first && second && !third) {
    result = await auditHistoricalRoomBundle(first, second, passphrase);
    if (!result.inventoryMatched) process.exitCode = 1;
  } else if (
    command === 'capture-d1' &&
    first &&
    (second === '--local' || second === '--remote') &&
    !third
  ) {
    result = await captureD1(first, second, passphrase);
  } else if (command === 'capture-chat' && first && second && third) {
    result = await captureChat(first, second, third, passphrase);
  } else if (command === 'capture-auth-media' && first && second && !third) {
    result = await captureAuthMedia(first, second, passphrase);
  } else if (
    command === 'capture-batch' &&
    first &&
    second &&
    third &&
    fourth &&
    fifth === '--remote'
  ) {
    result = await captureChatBackupBatch(fourth, passphrase, {
      d1: (destination) => captureD1(destination, '--remote', passphrase),
      d1Postflight: (firstBundle) => checkD1Postflight(firstBundle, passphrase),
      chat: (destination) => captureChat(second, third, destination, passphrase),
      authMedia: (destination) => captureAuthMedia(first, destination, passphrase),
    });
    if (result.state !== 'verified') process.exitCode = 1;
  } else if (command === 'verify-batch' && first && !second) {
    result = await verifyChatBackupBatch(first, passphrase);
    if (result.state !== 'verified') process.exitCode = 1;
  } else if (
    command === 'capture-scheduled' &&
    first &&
    second &&
    third &&
    fourth &&
    fifth === '--remote'
  ) {
    result = await runScheduledChatBackup(fourth, third, passphrase, {
      d1: (destination) => captureD1(destination, '--remote', passphrase),
      d1Postflight: (firstBundle) => checkD1Postflight(firstBundle, passphrase),
      chat: (destination) => captureChat(second, '--index', destination, passphrase),
      authMedia: (destination) => captureAuthMedia(first, destination, passphrase),
    });
    if (result.state !== 'verified') process.exitCode = 1;
  } else usage();
  // Counts only; never print sensitive filenames or plaintext.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
