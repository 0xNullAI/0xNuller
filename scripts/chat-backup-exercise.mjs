import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChatBackupBundle } from './chat-backup-bundle.mjs';

const roomCode = /^[A-Za-z0-9._:-]{1,128}$/;
const mediaKey = /^room\/([A-Za-z0-9._:-]{1,128})\/([A-Za-z0-9_-]{1,64})$/;

function issue(issues, code) {
  if (!issues.includes(code)) issues.push(code);
}

function array(value) {
  if (!Array.isArray(value)) throw new Error('Invalid restored backup JSON');
  return value;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Exercise restored bytes locally. The returned report contains counts and issue codes, never content. */
export async function exerciseChatBackup(d1Bundle, chatBundle, authMediaBundle, passphrase) {
  const root = await mkdtemp(join(tmpdir(), '0xnullai-restore-exercise-'));
  const issues = [];
  const report = {
    passed: false,
    d1Conversations: 0,
    d1Messages: 0,
    relationships: 0,
    memories: 0,
    conversationDigests: 0,
    authRoomBookmarks: 0,
    rooms: 0,
    roomMessages: 0,
    mediaObjects: 0,
    aiAttachments: 0,
    referencedMedia: 0,
    roomTombstones: 0,
    accountTombstones: 0,
    authAccountDeletions: 0,
    issues,
  };
  let db;
  try {
    const d1 = join(root, 'd1');
    const chat = join(root, 'chat');
    const authMedia = join(root, 'auth-media');
    await verifyChatBackupBundle(d1Bundle, passphrase, d1);
    await verifyChatBackupBundle(chatBundle, passphrase, chat);
    await verifyChatBackupBundle(authMediaBundle, passphrase, authMedia);
    db = new DatabaseSync(join(root, 'isolated.sqlite'));
    db.exec(await readFile(join(d1, 'auth-d1.sql'), 'utf8'));
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      issue(issues, 'd1_integrity_failed');
    report.d1Conversations = db.prepare('SELECT COUNT(*) AS n FROM server_conversations').get().n;
    report.d1Messages = db
      .prepare('SELECT COUNT(*) AS n FROM server_conversation_messages')
      .get().n;
    const deletionTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_deletions'")
      .get();
    if (!deletionTable) issue(issues, 'auth_account_deletion_table_missing');
    else {
      report.authAccountDeletions = db
        .prepare('SELECT COUNT(*) AS n FROM account_deletions')
        .get().n;
      if (report.authAccountDeletions) issue(issues, 'account_deletion_requires_scrub');
    }
    if (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM server_conversation_messages m
      LEFT JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
      WHERE c.id IS NULL`,
        )
        .get().n
    )
      issue(issues, 'd1_orphan_message');
    if (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
      SELECT user_id,conversation_id,position,COUNT(*) AS n
      FROM server_conversation_messages GROUP BY user_id,conversation_id,position HAVING n>1
    )`,
        )
        .get().n
    )
      issue(issues, 'd1_message_order_collision');
    const conversationColumns = new Set(
      db
        .prepare('PRAGMA table_info(server_conversations)')
        .all()
        .map((column) => column.name),
    );
    const messageColumns = new Set(
      db
        .prepare('PRAGMA table_info(server_conversation_messages)')
        .all()
        .map((column) => column.name),
    );
    if (
      !['metadata', 'last_sequence', 'read_sequence'].every((column) =>
        conversationColumns.has(column),
      ) ||
      !['role', 'content', 'created_at', 'sequence'].every((column) => messageColumns.has(column))
    ) {
      issue(issues, 'd1_conversation_schema_incomplete');
    } else {
      const unreadableConversations = db
        .prepare(
          `SELECT COUNT(*) AS n FROM server_conversations
        WHERE metadata IS NULL OR json_valid(metadata)=0 OR
          CASE WHEN json_valid(metadata)=1 THEN json_type(metadata) != 'object' ELSE 0 END`,
        )
        .get().n;
      if (unreadableConversations) issue(issues, 'd1_conversation_metadata_invalid');
      const invalidMessages = db
        .prepare(
          `SELECT COUNT(*) AS n FROM server_conversation_messages
        WHERE role NOT IN ('system','user','assistant') OR role IS NULL OR
          content IS NULL OR typeof(content) != 'text' OR
          created_at IS NULL OR typeof(created_at) != 'integer' OR created_at < 0 OR
          position IS NULL OR typeof(position) != 'integer' OR position < 0`,
        )
        .get().n;
      if (invalidMessages) issue(issues, 'd1_message_unreadable');
      const invalidSequences = db
        .prepare(
          `SELECT COUNT(*) AS n FROM server_conversations c
        WHERE c.last_sequence IS NULL OR typeof(c.last_sequence) != 'integer' OR
          c.last_sequence < 0 OR (c.read_sequence IS NOT NULL AND
          (typeof(c.read_sequence) != 'integer' OR c.read_sequence < 0 OR
            c.read_sequence > c.last_sequence)) OR
          EXISTS(SELECT 1 FROM server_conversation_messages m
            WHERE m.user_id=c.user_id AND m.conversation_id=c.id AND
              (m.sequence IS NULL OR typeof(m.sequence) != 'integer' OR
                m.sequence < 1 OR m.sequence > c.last_sequence))`,
        )
        .get().n;
      if (invalidSequences) issue(issues, 'd1_inbox_sequence_invalid');
    }
    // A readable transcript alone does not prove companion continuity can be restored.
    const memoryTables = [
      'character_relationships',
      'personal_memories',
      'memory_summary_sources',
      'conversation_digests',
    ];
    const availableTables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    if (memoryTables.some((name) => !availableTables.has(name))) {
      issue(issues, 'companion_memory_schema_missing');
    } else {
      report.relationships = db
        .prepare('SELECT COUNT(*) AS n FROM character_relationships WHERE deleted_at IS NULL')
        .get().n;
      report.memories = db
        .prepare('SELECT COUNT(*) AS n FROM personal_memories WHERE deleted_at IS NULL')
        .get().n;
      report.conversationDigests = db
        .prepare('SELECT COUNT(*) AS n FROM conversation_digests')
        .get().n;
      // A tombstone must not restore erased companion text. SQLite integrity alone
      // cannot prove this, and an older export may retain stale reverse links.
      if (
        db
          .prepare(
            `SELECT 1 FROM personal_memories
          WHERE deleted_at IS NOT NULL AND (title <> '' OR content <> '') LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'deleted_companion_memory_text_present');
      if (
        db
          .prepare(
            `SELECT 1 FROM memory_summary_sources s
          LEFT JOIN personal_memories m ON m.user_id=s.user_id AND m.id=s.memory_id
          WHERE m.id IS NULL OR m.deleted_at IS NOT NULL LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'companion_memory_source_index_stale');
      if (
        db
          .prepare(
            `SELECT 1 FROM personal_memories m
        LEFT JOIN character_relationships r ON r.user_id=m.user_id AND r.id=m.relationship_id
        WHERE m.deleted_at IS NULL AND m.scope='relationship'
          AND (r.id IS NULL OR r.deleted_at IS NOT NULL) LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'companion_memory_relationship_missing');
      if (
        db
          .prepare(
            `SELECT 1 FROM memory_summary_sources s
        JOIN personal_memories m ON m.user_id=s.user_id AND m.id=s.memory_id
        LEFT JOIN server_conversation_messages msg ON msg.user_id=s.user_id
          AND msg.conversation_id=s.conversation_id AND msg.id=s.message_id
        WHERE m.deleted_at IS NULL AND msg.id IS NULL LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'companion_memory_source_missing');
      // Source provenance is stored twice: JSON for display and a reverse index for invalidation.
      if (
        db
          .prepare(
            `SELECT 1 FROM personal_memories m WHERE m.deleted_at IS NULL AND (
          json_valid(m.source_refs)=0 OR
          json_type(CASE WHEN json_valid(m.source_refs) THEN m.source_refs ELSE '[]' END)!='array' OR
          json_array_length(CASE WHEN json_valid(m.source_refs) THEN m.source_refs ELSE '[]' END) !=
            (SELECT COUNT(*) FROM memory_summary_sources s
             WHERE s.user_id=m.user_id AND s.memory_id=m.id) OR
          EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.source_refs)
            THEN m.source_refs ELSE '[]' END) ref
            WHERE NOT EXISTS(SELECT 1 FROM memory_summary_sources s
              WHERE s.user_id=m.user_id AND s.memory_id=m.id AND
                s.conversation_id=json_extract(CASE WHEN json_valid(ref.value)
                  THEN ref.value ELSE '{}' END,'$.conversationId') AND
                s.message_id=json_extract(CASE WHEN json_valid(ref.value)
                  THEN ref.value ELSE '{}' END,'$.messageId')))
        ) LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'companion_memory_source_index_mismatch');
      if (
        db
          .prepare(
            `SELECT 1 FROM conversation_digests d
        LEFT JOIN server_conversations c ON c.user_id=d.user_id AND c.id=d.conversation_id
        LEFT JOIN character_relationships r ON r.user_id=d.user_id AND r.id=d.relationship_id
        LEFT JOIN server_conversation_messages m ON m.user_id=d.user_id
          AND m.conversation_id=d.conversation_id AND m.id=d.through_message_id
          AND m.position=d.through_position
        WHERE c.id IS NULL OR c.deleted_at IS NOT NULL OR r.id IS NULL OR
          r.deleted_at IS NOT NULL OR m.id IS NULL OR
          (json_valid(c.metadata)=1 AND
            json_extract(c.metadata,'$.relationshipId') IS NOT d.relationship_id)
        LIMIT 1`,
          )
          .get()
      )
        issue(issues, 'conversation_digest_source_missing');
    }
    const attachmentTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_conversation_attachments'",
      )
      .get();
    const attachments = attachmentTable
      ? db
          .prepare(
            "SELECT object_key,size,mime FROM private_conversation_attachments WHERE status='ready'",
          )
          .all()
      : [];
    report.aiAttachments = attachments.length;
    if (attachmentTable) {
      const attachmentColumns = db
        .prepare('PRAGMA table_info(private_conversation_attachments)')
        .all();
      if (attachmentColumns.some((column) => column.name === 'message_id')) {
        const orphaned = db
          .prepare(
            `SELECT COUNT(*) AS n FROM private_conversation_attachments a
           LEFT JOIN server_conversation_messages m
             ON m.user_id=a.user_id AND m.conversation_id=a.conversation_id AND m.id=a.message_id
           WHERE a.status='ready' AND (a.message_id IS NULL OR m.id IS NULL)`,
          )
          .get().n;
        if (orphaned) issue(issues, 'ai_attachment_message_missing');
      }
    }
    const authManifest = await json(join(authMedia, 'attachments.json'));
    if (authManifest.kind !== 'auth-private-ai-attachments' || !Array.isArray(authManifest.objects))
      throw new Error('Invalid restored Auth media manifest');
    let authFiles;
    try {
      authFiles = await readdir(join(authMedia, 'objects'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      authFiles = [];
    }
    if (
      authManifest.count !== authManifest.objects.length ||
      authFiles.length !== authManifest.objects.length ||
      attachments.length !== authManifest.objects.length
    )
      issue(issues, 'ai_media_coverage_mismatch');
    const attachmentByKey = new Map(attachments.map((row) => [row.object_key, row]));
    const seenAuth = new Set();
    for (const [index, item] of authManifest.objects.entries()) {
      if (
        !item ||
        typeof item.key !== 'string' ||
        seenAuth.has(item.key) ||
        item.file !== `${String(index).padStart(8, '0')}.bin`
      )
        throw new Error('Invalid restored Auth media entry');
      seenAuth.add(item.key);
      const source = attachmentByKey.get(item.key);
      if (!source || source.size !== item.size || source.mime !== item.mime)
        issue(issues, 'ai_media_reference_missing');
      if ((await stat(join(authMedia, 'objects', item.file))).size !== item.size)
        issue(issues, 'ai_media_size_mismatch');
    }

    const coverage = await json(join(chat, 'coverage.json'));
    if (coverage.historicalCoverage !== 'verified')
      issue(issues, 'historical_room_coverage_unverified');
    if (coverage.mediaEnumeration !== 'all-current-R2-objects')
      issue(issues, 'media_coverage_unverified');
    let roomIndex;
    try {
      roomIndex = array(await json(join(chat, 'room-index.json')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      issue(issues, 'room_index_missing');
      roomIndex = [];
    }
    const accountTombstones = array(await json(join(chat, 'account-tombstones.json')));
    report.accountTombstones = accountTombstones.length;
    if (accountTombstones.length) issue(issues, 'account_deletion_requires_scrub');
    const rooms = new Map();
    for (const entry of roomIndex) {
      if (
        !entry ||
        typeof entry.code !== 'string' ||
        !roomCode.test(entry.code) ||
        rooms.has(entry.code) ||
        !['group', 'dm'].includes(entry.kind)
      )
        throw new Error('Invalid restored room index');
      rooms.set(entry.code, entry);
      if (entry.deleted_at != null) report.roomTombstones++;
    }
    const bookmarkTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_chat_rooms'")
      .get();
    if (!bookmarkTable) issue(issues, 'auth_room_bookmark_table_missing');
    else {
      const bookmarks = db.prepare('SELECT DISTINCT code FROM user_chat_rooms').all();
      report.authRoomBookmarks = bookmarks.length;
      for (const bookmark of bookmarks) {
        if (!rooms.has(bookmark.code)) issue(issues, 'auth_room_bookmark_missing_from_chat');
        else if (rooms.get(bookmark.code).kind !== 'group')
          issue(issues, 'auth_room_bookmark_kind_mismatch');
      }
    }
    const files = await readdir(join(chat, 'rooms'));
    if (files.length !== rooms.size || coverage.rooms !== rooms.size)
      issue(issues, 'room_index_coverage_mismatch');
    const media = array(coverage.media);
    if (coverage.mediaCount !== media.length) issue(issues, 'media_count_mismatch');
    const mediaByKey = new Map();
    for (const [index, item] of media.entries()) {
      if (
        !item ||
        typeof item.key !== 'string' ||
        !mediaKey.test(item.key) ||
        mediaByKey.has(item.key) ||
        item.file !== `${String(index).padStart(8, '0')}.bin`
      )
        throw new Error('Invalid restored media manifest');
      mediaByKey.set(item.key, item);
      if ((await stat(join(chat, 'media', item.file))).size !== item.size)
        issue(issues, 'media_size_mismatch');
      const owningRoom = rooms.get(mediaKey.exec(item.key)[1]);
      if (!owningRoom) issue(issues, 'media_room_not_indexed');
      if (owningRoom?.deleted_at != null) issue(issues, 'deleted_room_media_present');
    }
    report.mediaObjects = media.length;
    if ((await readdir(join(chat, 'media'))).length !== media.length)
      issue(issues, 'media_file_count_mismatch');
    const referencedMediaKeys = new Set();
    for (const filename of files) {
      if (!filename.endsWith('.json')) throw new Error('Invalid restored room filename');
      const code = decodeURIComponent(filename.slice(0, -5));
      if (!roomCode.test(code) || filename !== `${encodeURIComponent(code)}.json`)
        throw new Error('Invalid restored room filename');
      if (!rooms.has(code)) issue(issues, 'room_index_coverage_mismatch');
      const messages = array(await json(join(chat, 'rooms', filename)));
      report.rooms++;
      report.roomMessages += messages.length;
      if (rooms.get(code)?.deleted_at != null && messages.length)
        issue(issues, 'deleted_room_messages_present');
      const ids = new Set();
      let previous;
      for (const row of messages) {
        if (
          !row ||
          typeof row.id !== 'string' ||
          !row.id ||
          ids.has(row.id) ||
          !Number.isSafeInteger(row.ts) ||
          row.ts < 0 ||
          typeof row.body !== 'string'
        ) {
          issue(issues, 'room_message_invalid');
          continue;
        }
        ids.add(row.id);
        if (previous && (row.ts > previous.ts || (row.ts === previous.ts && row.id >= previous.id)))
          issue(issues, 'room_message_order_invalid');
        previous = row;
        let body;
        try {
          body = JSON.parse(row.body);
        } catch {
          issue(issues, 'room_message_body_invalid');
          continue;
        }
        if (!body || typeof body !== 'object') {
          issue(issues, 'room_message_body_invalid');
          continue;
        }
        if (body.x !== undefined && typeof body.x !== 'string')
          issue(issues, 'room_message_body_invalid');
        if (body.m) {
          if (
            typeof body.m !== 'object' ||
            typeof body.m.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(body.m.id) ||
            !Number.isSafeInteger(body.m.size) ||
            body.m.size < 0
          ) {
            issue(issues, 'room_message_body_invalid');
            continue;
          }
          report.referencedMedia++;
          const key = `room/${code}/${body.m.id}`;
          referencedMediaKeys.add(key);
          if (!mediaByKey.has(key) || body.m.size !== mediaByKey.get(key).size)
            issue(issues, 'room_media_reference_missing');
        }
      }
    }
    for (const key of mediaByKey.keys())
      if (!referencedMediaKeys.has(key)) issue(issues, 'unreferenced_room_media');
    report.passed = issues.length === 0;
    return report;
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}
