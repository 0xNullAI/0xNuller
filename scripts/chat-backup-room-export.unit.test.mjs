import { expect, test } from 'vitest';
import { captureConsistentRoomMessages } from './chat-backup-room-export.mjs';

function pageReader(rows) {
  return async (room, before) => {
    const available = before
      ? rows.filter((row) => row.ts < before.ts || (row.ts === before.ts && row.id < before.id))
      : rows;
    const messages = available.slice(0, 2);
    return {
      room,
      exists: true,
      messages,
      totalMessages: rows.length,
      before: available.length > 2 ? { ts: messages.at(-1).ts, id: messages.at(-1).id } : null,
    };
  };
}

test('captures a stable room twice using the same cursor order', async () => {
  const rows = [
    { id: 'c', ts: 3, body: 'three' },
    { id: 'b', ts: 2, body: 'two' },
    { id: 'a', ts: 1, body: 'one' },
  ];
  expect(await captureConsistentRoomMessages('room', pageReader(rows))).toEqual(rows);
});

test('rejects a room that changes between the two export scans', async () => {
  const rows = [
    { id: 'b', ts: 2, body: 'two' },
    { id: 'a', ts: 1, body: 'one' },
  ];
  let scans = 0;
  const read = pageReader(rows);
  await expect(
    captureConsistentRoomMessages('room', async (room, before) => {
      if (!before && ++scans === 2) rows.unshift({ id: 'c', ts: 3, body: 'three' });
      return read(room, before);
    }),
  ).rejects.toThrow('changed during export');
});

test('rejects a message body changed without changing its ID or timestamp', async () => {
  const rows = [{ id: 'a', ts: 1, body: 'before' }];
  let scans = 0;
  const read = pageReader(rows);
  await expect(
    captureConsistentRoomMessages('room', async (room, before) => {
      if (!before && ++scans === 2) rows[0].body = 'after';
      return read(room, before);
    }),
  ).rejects.toThrow('changed during export');
});

test('rejects duplicate or non-progressing room pages', async () => {
  await expect(
    captureConsistentRoomMessages('room', async (room) => ({
      room,
      exists: true,
      messages: [{ id: 'a', ts: 1, body: 'one' }],
      before: { ts: 1, id: 'a' },
      totalMessages: 2,
    })),
  ).rejects.toThrow('order');
});

test('rejects a stable but prematurely truncated room export', async () => {
  const rows = [
    { id: 'b', ts: 2, body: 'two' },
    { id: 'a', ts: 1, body: 'one' },
  ];
  await expect(
    captureConsistentRoomMessages('room', async (room) => ({
      room,
      exists: true,
      messages: [rows[0]],
      before: null,
      totalMessages: rows.length,
    })),
  ).rejects.toThrow('ended early');
});

test('fails closed when a deployed exporter does not provide a total count', async () => {
  await expect(
    captureConsistentRoomMessages('room', async (room) => ({
      room,
      exists: true,
      messages: [],
      before: null,
    })),
  ).rejects.toThrow('Invalid room export page');
});

test('rejects an export when the room total changes between pages', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: `m${101 - index}`,
    ts: 101 - index,
    body: 'text',
  }));
  await expect(
    captureConsistentRoomMessages('room', async (room, before) => ({
      room,
      exists: true,
      messages: before ? [rows[100]] : rows.slice(0, 100),
      before: before ? null : { ts: rows[99].ts, id: rows[99].id },
      totalMessages: before ? 102 : 101,
    })),
  ).rejects.toThrow('Invalid room export page');
});

test('rejects an indexed historical hint for a RoomDO with no matching persisted identity', async () => {
  await expect(
    captureConsistentRoomMessages('missing-room', async (room) => ({
      room,
      exists: false,
      messages: [],
      before: null,
      totalMessages: 0,
    })),
  ).rejects.toThrow('Invalid room export page');
});

test('fails closed when an older deployed exporter cannot attest the RoomDO identity', async () => {
  await expect(
    captureConsistentRoomMessages('room', async (room) => ({
      room,
      messages: [],
      before: null,
      totalMessages: 0,
    })),
  ).rejects.toThrow('Invalid room export page');
});
