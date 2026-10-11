import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createChatBackupBundle } from './chat-backup-bundle.mjs';
import { exerciseChatBackup } from './chat-backup-exercise.mjs';

const passphrase = 'long isolated exercise test passphrase';

async function fixture(change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'chat-exercise-test-'));
  const d1 = join(root, 'd1-source');
  const chat = join(root, 'chat-source');
  const authMedia = join(root, 'auth-media-source');
  await mkdir(d1);
  await mkdir(join(authMedia, 'objects'), { recursive: true });
  await mkdir(join(chat, 'rooms'), { recursive: true });
  await mkdir(join(chat, 'media'));
  const data = {
    roomCode: 'room-1',
    coverage: {
      rooms: 1,
      mediaCount: 1,
      roomEnumeration: 'observed-and-explicit-hints',
      historicalCoverage: 'verified',
      mediaEnumeration: 'all-current-R2-objects',
      media: [{ key: 'room/room-1/picture', size: 3, file: '00000000.bin' }],
    },
    index: [{ code: 'room-1', kind: 'group', deleted_at: null }],
    tombstones: [],
    authDeletion: false,
    authDeletionTable: true,
    conversationMetadata: '{"relationshipId":"r1"}',
    conversationLastSequence: 1,
    messageSequence: 1,
    messageRole: 'user',
    aiAttachment: null,
    aiAttachmentMessageId: 'a1',
    memorySourceMessageId: 'a1',
    memoryJsonSourceMessageId: 'a1',
    digestSourceMessageId: 'a1',
    relationshipDeleted: false,
    memoryDeleted: false,
    memoryTitle: '记忆',
    memoryContent: '已经确认的内容',
    includeOrphanMemoryIndex: false,
    includeMemory: true,
    includeDigest: true,
    includeMemoryIndex: true,
    includeMemorySchema: true,
    bookmarkCode: 'room-1',
    messages: [
      {
        id: 'm2',
        from_id: 'p1',
        name: 'A',
        ts: 20,
        body: JSON.stringify({ id: 'm2', m: { id: 'picture', size: 3 } }),
      },
      {
        id: 'm1',
        from_id: 'p2',
        name: 'B',
        ts: 10,
        body: JSON.stringify({ id: 'm1', x: 'hello' }),
      },
    ],
  };
  change(data);
  await writeFile(
    join(d1, 'auth-d1.sql'),
    `
    CREATE TABLE server_conversations(user_id TEXT,id TEXT,metadata TEXT,last_sequence INTEGER,
      read_sequence INTEGER,deleted_at INTEGER,PRIMARY KEY(user_id,id));
    CREATE TABLE server_conversation_messages(user_id TEXT,conversation_id TEXT,id TEXT,position INTEGER,
      role TEXT,content TEXT,created_at INTEGER,sequence INTEGER,
      PRIMARY KEY(user_id,conversation_id,id),FOREIGN KEY(user_id,conversation_id)
      REFERENCES server_conversations(user_id,id));
    INSERT INTO server_conversations VALUES('u1','c1','${data.conversationMetadata}',${data.conversationLastSequence},NULL,NULL);
    INSERT INTO server_conversation_messages VALUES('u1','c1','a1',1,'${data.messageRole}','hello',1,${data.messageSequence});
    ${data.authDeletionTable ? 'CREATE TABLE account_deletions(user_id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL);' : ''}
    ${data.authDeletion ? "INSERT INTO account_deletions VALUES('u1',123);" : ''}
    CREATE TABLE private_conversation_attachments(user_id TEXT,conversation_id TEXT,message_id TEXT,
      object_key TEXT,status TEXT,size INTEGER,mime TEXT);
    ${
      data.includeMemorySchema
        ? `CREATE TABLE character_relationships(user_id TEXT,id TEXT,deleted_at INTEGER,PRIMARY KEY(user_id,id));
    INSERT INTO character_relationships VALUES('u1','r1',${data.relationshipDeleted ? 100 : 'NULL'});
    CREATE TABLE personal_memories(user_id TEXT,id TEXT,scope TEXT,relationship_id TEXT,
      title TEXT,content TEXT,source_refs TEXT,deleted_at INTEGER,PRIMARY KEY(user_id,id));
    CREATE TABLE memory_summary_sources(user_id TEXT,memory_id TEXT,conversation_id TEXT,message_id TEXT);
    CREATE TABLE conversation_digests(user_id TEXT,conversation_id TEXT,relationship_id TEXT,
      through_position INTEGER,through_message_id TEXT);
    ${
      data.includeMemory
        ? `INSERT INTO personal_memories VALUES('u1','memory-1','relationship','r1',
      '${data.memoryTitle}','${data.memoryContent}',
      '[{"conversationId":"c1","messageId":"${data.memoryJsonSourceMessageId}"}]',${data.memoryDeleted ? '123' : 'NULL'});
      ${data.includeMemoryIndex ? `INSERT INTO memory_summary_sources VALUES('u1','memory-1','c1','${data.memorySourceMessageId}');` : ''}`
        : ''
    }
    ${data.includeOrphanMemoryIndex ? "INSERT INTO memory_summary_sources VALUES('u1','missing-memory','c1','a1');" : ''}
    ${data.includeDigest ? `INSERT INTO conversation_digests VALUES('u1','c1','r1',1,'${data.digestSourceMessageId}');` : ''}`
        : ''
    }
    CREATE TABLE user_chat_rooms(user_id TEXT,code TEXT,PRIMARY KEY(user_id,code));
    ${data.bookmarkCode ? `INSERT INTO user_chat_rooms VALUES('u1','${data.bookmarkCode}');` : ''}
    ${data.aiAttachment ? `INSERT INTO private_conversation_attachments VALUES('u1','c1','${data.aiAttachmentMessageId}','users/u1/conversations/c1/attachments/a1','ready',3,'image/png');` : ''}
  `,
  );
  await writeFile(join(chat, 'coverage.json'), JSON.stringify(data.coverage));
  if (data.index) await writeFile(join(chat, 'room-index.json'), JSON.stringify(data.index));
  await writeFile(join(chat, 'account-tombstones.json'), JSON.stringify(data.tombstones));
  await writeFile(
    join(chat, 'rooms', `${encodeURIComponent(data.roomCode)}.json`),
    JSON.stringify(data.messages),
  );
  await writeFile(join(chat, 'media', '00000000.bin'), 'abc');
  const authObjects =
    data.aiAttachment === 'captured'
      ? [
          {
            key: 'users/u1/conversations/c1/attachments/a1',
            size: 3,
            mime: 'image/png',
            etag: 'test',
            file: '00000000.bin',
          },
        ]
      : [];
  if (authObjects.length) await writeFile(join(authMedia, 'objects', '00000000.bin'), 'xyz');
  await writeFile(
    join(authMedia, 'attachments.json'),
    JSON.stringify({
      kind: 'auth-private-ai-attachments',
      count: authObjects.length,
      objects: authObjects,
    }),
  );
  const d1Bundle = join(root, 'd1-bundle');
  const chatBundle = join(root, 'chat-bundle');
  const authMediaBundle = join(root, 'auth-media-bundle');
  await createChatBackupBundle(d1, d1Bundle, passphrase);
  await createChatBackupBundle(chat, chatBundle, passphrase);
  await createChatBackupBundle(authMedia, authMediaBundle, passphrase);
  return { root, d1Bundle, chatBundle, authMediaBundle };
}

test('isolated exercise imports D1 and checks ordered room messages and referenced media', async () => {
  const item = await fixture();
  try {
    expect(
      await exerciseChatBackup(item.d1Bundle, item.chatBundle, item.authMediaBundle, passphrase),
    ).toMatchObject({
      passed: true,
      d1Conversations: 1,
      d1Messages: 1,
      relationships: 1,
      memories: 1,
      conversationDigests: 1,
      rooms: 1,
      roomMessages: 2,
      mediaObjects: 1,
      referencedMedia: 1,
      issues: [],
    });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('restored companion memory must retain an active relationship and its source message', async () => {
  for (const [change, expected] of [
    [
      (data) => {
        data.relationshipDeleted = true;
      },
      'companion_memory_relationship_missing',
    ],
    [
      (data) => {
        data.memorySourceMessageId = 'missing';
      },
      'companion_memory_source_missing',
    ],
    [
      (data) => {
        data.includeMemoryIndex = false;
      },
      'companion_memory_source_index_mismatch',
    ],
    [
      (data) => {
        data.memoryJsonSourceMessageId = 'different';
      },
      'companion_memory_source_index_mismatch',
    ],
    [
      (data) => {
        data.digestSourceMessageId = 'missing';
      },
      'conversation_digest_source_missing',
    ],
  ]) {
    const item = await fixture(change);
    try {
      const report = await exerciseChatBackup(
        item.d1Bundle,
        item.chatBundle,
        item.authMediaBundle,
        passphrase,
      );
      expect(report.passed).toBe(false);
      expect(report.issues).toContain(expected);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
});

test('isolated recovery rejects erased memory text and stale provenance links', async () => {
  for (const [change, expected] of [
    [
      (data) => {
        data.memoryDeleted = true;
        data.includeMemoryIndex = false;
      },
      'deleted_companion_memory_text_present',
    ],
    [
      (data) => {
        data.memoryDeleted = true;
        data.memoryTitle = '';
        data.memoryContent = '';
      },
      'companion_memory_source_index_stale',
    ],
    [
      (data) => {
        data.includeOrphanMemoryIndex = true;
      },
      'companion_memory_source_index_stale',
    ],
  ]) {
    const item = await fixture(change);
    try {
      const report = await exerciseChatBackup(
        item.d1Bundle,
        item.chatBundle,
        item.authMediaBundle,
        passphrase,
      );
      expect(report.passed).toBe(false);
      expect(report.issues).toContain(expected);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  }
});

test('a transcript-only D1 snapshot cannot be certified as a companion backup', async () => {
  const item = await fixture((data) => {
    data.includeMemorySchema = false;
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('companion_memory_schema_missing');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise rejects AI conversations whose metadata cannot be read after restore', async () => {
  const item = await fixture((data) => {
    data.conversationMetadata = '{broken';
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('d1_conversation_metadata_invalid');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise rejects a restored AI message with an invalid role or inbox sequence', async () => {
  const item = await fixture((data) => {
    data.messageRole = 'unknown';
    data.messageSequence = 2;
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining(['d1_message_unreadable', 'd1_inbox_sequence_invalid']),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('isolated exercise accepts media in a private DM room', async () => {
  const item = await fixture((data) => {
    data.roomCode = `dm:${'a'.repeat(64)}`;
    data.coverage.media[0].key = `room/${data.roomCode}/picture`;
    data.index[0].code = data.roomCode;
    data.index[0].kind = 'dm';
    data.bookmarkCode = null;
  });
  try {
    expect(
      await exerciseChatBackup(item.d1Bundle, item.chatBundle, item.authMediaBundle, passphrase),
    ).toMatchObject({ passed: true, rooms: 1, mediaObjects: 1, referencedMedia: 1, issues: [] });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise rejects unverified coverage, broken ordering and media references', async () => {
  const item = await fixture((data) => {
    data.coverage.historicalCoverage = 'unverified';
    data.coverage.media[0].key = 'room/room-1/other';
    data.messages.reverse();
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        'historical_room_coverage_unverified',
        'room_message_order_invalid',
        'room_media_reference_missing',
      ]),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise rejects media captured without a corresponding room message', async () => {
  const item = await fixture((data) => {
    data.messages[0].body = JSON.stringify({ id: 'm2', x: 'message without media' });
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('unreferenced_room_media');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise prevents deleted room and account records from passing recovery', async () => {
  const item = await fixture((data) => {
    data.index[0].deleted_at = 123;
    data.tombstones.push({ account_id: 'u1', deletion_id: 'delete-1', deleted_at: 123 });
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        'account_deletion_requires_scrub',
        'deleted_room_messages_present',
        'deleted_room_media_present',
      ]),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise catches an Auth deletion job even when the Chat tombstone snapshot is empty', async () => {
  const item = await fixture((data) => {
    data.authDeletion = true;
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report).toMatchObject({
      passed: false,
      authAccountDeletions: 1,
      accountTombstones: 0,
    });
    expect(report.issues).toContain('account_deletion_requires_scrub');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise cannot certify an Auth export without the deletion marker table', async () => {
  const item = await fixture((data) => {
    data.authDeletionTable = false;
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('auth_account_deletion_table_missing');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('operator-supplied capture without a room index reports a coverage gap', async () => {
  const item = await fixture((data) => {
    data.index = null;
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('room_index_missing');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise cross-checks Auth room bookmarks against the independent Chat room index', async () => {
  const item = await fixture((data) => {
    data.bookmarkCode = 'older-room-not-in-chat-index';
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.authRoomBookmarks).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('auth_room_bookmark_missing_from_chat');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise rejects a corrupt restored room media reference without crashing', async () => {
  const item = await fixture((data) => {
    data.messages[0].body = JSON.stringify({ m: { id: '../escape', size: -1 } });
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('room_message_body_invalid');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('exercise requires every ready private AI attachment in encrypted Auth media capture', async () => {
  const missing = await fixture((data) => {
    data.aiAttachment = 'missing';
  });
  const captured = await fixture((data) => {
    data.aiAttachment = 'captured';
  });
  try {
    expect(
      (
        await exerciseChatBackup(
          missing.d1Bundle,
          missing.chatBundle,
          missing.authMediaBundle,
          passphrase,
        )
      ).issues,
    ).toContain('ai_media_coverage_mismatch');
    expect(
      (
        await exerciseChatBackup(
          captured.d1Bundle,
          captured.chatBundle,
          captured.authMediaBundle,
          passphrase,
        )
      ).passed,
    ).toBe(true);
  } finally {
    await rm(missing.root, { recursive: true, force: true });
    await rm(captured.root, { recursive: true, force: true });
  }
});

test('exercise rejects an Auth media object absent from the D1 snapshot', async () => {
  const item = await fixture((data) => {
    data.aiAttachment = 'captured';
  });
  const d1Only = await fixture();
  try {
    const report = await exerciseChatBackup(
      d1Only.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining(['ai_media_coverage_mismatch', 'ai_media_reference_missing']),
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
    await rm(d1Only.root, { recursive: true, force: true });
  }
});

test('exercise rejects a captured AI attachment whose message is missing', async () => {
  const item = await fixture((data) => {
    data.aiAttachment = 'captured';
    data.aiAttachmentMessageId = 'missing-message';
  });
  try {
    const report = await exerciseChatBackup(
      item.d1Bundle,
      item.chatBundle,
      item.authMediaBundle,
      passphrase,
    );
    expect(report.passed).toBe(false);
    expect(report.issues).toContain('ai_attachment_message_missing');
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
