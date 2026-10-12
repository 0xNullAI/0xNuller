import { MEMORY_COLUMNS, type MemoryRow } from './memory-records';
import { sha256Hex, type SessionEnv } from './session-domain';

interface ConversationRow {
  id: string;
}
interface MessageRow {
  id: string;
  content: string;
}
interface HistoryMessageRow extends MessageRow {
  row_number: number;
}
interface SourceRef {
  conversationId: string;
  messageId: string;
}
interface EvidenceRef extends SourceRef {
  content: string;
}

const HISTORY_CHUNK_SIZE = 8;
const MAX_HISTORY_CHUNKS = 3;

async function insertReviewableExcerpt(
  env: Pick<SessionEnv, 'DB'>,
  userId: string,
  relationshipId: string,
  refs: EvidenceRef[],
  title: string,
  content: string,
  prefix: 'segment' | 'history',
  minConversations: number,
  maxConversations: number,
  now: number,
): Promise<MemoryRow | null> {
  const sourceRefs: SourceRef[] = refs.map(({ conversationId, messageId }) => ({
    conversationId,
    messageId,
  }));
  const identity = JSON.stringify(
    sourceRefs
      .map(({ conversationId, messageId }): [string, string] => [conversationId, messageId])
      .sort(
        ([aConversation, aMessage], [bConversation, bMessage]) =>
          aConversation.localeCompare(bConversation) || aMessage.localeCompare(bMessage),
      ),
  );
  const id = `${prefix}-${(await sha256Hex(`${userId}:${relationshipId}:${identity}`)).slice(0, 48)}`;
  // One statement validates the exact source text, owner and relationship, then
  // migration 0047 indexes all source IDs. A deleted candidate stays a tombstone.
  return env.DB.prepare(
    `WITH refs AS (
       SELECT json_extract(value,'$.conversationId') AS conversation_id,
              json_extract(value,'$.messageId') AS message_id,
              json_extract(value,'$.content') AS content
       FROM json_each(?)
     )
     INSERT INTO personal_memories
       (user_id,id,kind,title,content,version,created_at,updated_at,scope,
        relationship_id,tier,state,source_conversation_id,source_message_ids,source_refs,expires_at)
     SELECT ?,?,'note',?,?,1,?,?,'relationship',?,'medium','suggested',NULL,'[]',?,?
     WHERE (SELECT COUNT(*) FROM refs)=?
       AND (SELECT COUNT(DISTINCT conversation_id) FROM refs) BETWEEN ? AND ?
       AND NOT EXISTS (
         SELECT 1 FROM refs e
         LEFT JOIN server_conversations c ON c.user_id=? AND c.id=e.conversation_id
           AND c.deleted_at IS NULL
         LEFT JOIN character_relationships r ON r.user_id=c.user_id
           AND r.id=json_extract(c.metadata,'$.relationshipId')
           AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
           AND r.id=? AND r.deleted_at IS NULL
         LEFT JOIN server_conversation_messages m ON m.user_id=c.user_id
           AND m.conversation_id=c.id AND m.id=e.message_id AND m.role='user'
         WHERE c.id IS NULL OR r.id IS NULL OR m.id IS NULL OR m.content<>e.content
       )
       AND EXISTS(SELECT 1 FROM users u JOIN character_relationships r ON r.user_id=u.id
         WHERE u.id=? AND u.banned_at IS NULL AND r.id=? AND r.deleted_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id))
       AND (SELECT COUNT(*) FROM personal_memories WHERE user_id=? AND deleted_at IS NULL)<200
     ON CONFLICT(user_id,id) DO NOTHING RETURNING ${MEMORY_COLUMNS}`,
  )
    .bind(
      JSON.stringify(refs),
      userId,
      id,
      title,
      content,
      now,
      now,
      relationshipId,
      JSON.stringify(sourceRefs),
      now + 30 * 86400_000,
      refs.length,
      minConversations,
      maxConversations,
      userId,
      relationshipId,
      userId,
      relationshipId,
      userId,
    )
    .first<MemoryRow>();
}

/**
 * Stage an extractive cross-conversation digest. Every visible line is a bounded
 * excerpt of one user message; no model invents a fact or sees extra private text.
 */
export async function stageSegmentedMemory(
  env: Pick<SessionEnv, 'DB'>,
  userId: string,
  relationshipId: string,
  now = Date.now(),
): Promise<MemoryRow | null> {
  const conversations = await env.DB.prepare(
    `SELECT c.id FROM server_conversations c
     JOIN character_relationships r ON r.user_id=c.user_id
       AND r.id=json_extract(c.metadata,'$.relationshipId')
       AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
     WHERE c.user_id=? AND r.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
       AND EXISTS(SELECT 1 FROM server_conversation_messages m
         WHERE m.user_id=c.user_id AND m.conversation_id=c.id AND m.role='user'
           AND length(m.content) BETWEEN 4 AND 1000)
     ORDER BY c.updated_at DESC,c.id ASC LIMIT 6`,
  )
    .bind(userId, relationshipId)
    .all<ConversationRow>();
  const segments: MessageRow[][] = [];
  const refs: EvidenceRef[] = [];
  for (const conversation of conversations.results) {
    const messages = await env.DB.prepare(
      `SELECT id,content FROM server_conversation_messages
       WHERE user_id=? AND conversation_id=? AND role='user'
         AND length(content) BETWEEN 4 AND 1000
       ORDER BY position DESC,id DESC LIMIT 2`,
    )
      .bind(userId, conversation.id)
      .all<MessageRow>();
    if (!messages.results.length) continue;
    const ordered = messages.results.reverse();
    segments.push(ordered);
    refs.push(
      ...ordered.map((message) => ({
        conversationId: conversation.id,
        messageId: message.id,
        content: message.content,
      })),
    );
    if (segments.length === 3) break;
  }
  if (segments.length < 2) return null;

  const title = '跨会话用户原文分段摘录（待核对）';
  const content = segments
    .map((messages, index) =>
      [
        `第 ${index + 1} 段`,
        ...messages.map((message) => `[用户原文片段] ${message.content.slice(0, 300)}`),
      ].join('\n'),
    )
    .join('\n\n');
  return insertReviewableExcerpt(
    env,
    userId,
    relationshipId,
    refs,
    title,
    content,
    'segment',
    2,
    3,
    now,
  );
}

/** Stage complete eight-message windows that have left the short-term chat window. */
export async function stageConversationHistoryMemories(
  env: Pick<SessionEnv, 'DB'>,
  userId: string,
  relationshipId: string,
  conversationId: string,
  before: { position: number; id: string },
  now = Date.now(),
): Promise<MemoryRow[]> {
  const rows = await env.DB.prepare(
    `WITH older AS (
       SELECT m.id,m.content,
         ROW_NUMBER() OVER (ORDER BY m.position ASC,m.id ASC) AS row_number,
         COUNT(*) OVER () AS total
       FROM server_conversation_messages m
       JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
       JOIN character_relationships r ON r.user_id=c.user_id
         AND r.id=json_extract(c.metadata,'$.relationshipId')
         AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
       WHERE m.user_id=? AND m.conversation_id=? AND c.deleted_at IS NULL
         AND r.id=? AND r.deleted_at IS NULL AND m.role='user'
         AND length(m.content) BETWEEN 4 AND 1000
         AND (m.position<? OR (m.position=? AND m.id<?))
     ), complete AS (
       SELECT id,content,row_number,CAST((row_number-1)/? AS INTEGER) AS chunk_index
       FROM older WHERE row_number<=total-(total%?)
     ), windows AS (
       SELECT chunk_index,
         MIN(CASE WHEN (row_number-1)%?=0 THEN id END) AS first_id,
         COUNT(*) AS message_count
       FROM complete GROUP BY chunk_index
     ), pending AS (
       SELECT chunk_index FROM windows w
       WHERE message_count=? AND NOT EXISTS (
         SELECT 1 FROM personal_memories p, json_each(p.source_refs) ref
         WHERE p.user_id=? AND p.relationship_id=?
           AND p.id LIKE 'history-%'
           AND json_extract(ref.value,'$.conversationId')=?
           AND json_extract(ref.value,'$.messageId')=w.first_id
       )
       ORDER BY chunk_index ASC LIMIT ?
     )
     SELECT c.id,c.content,c.row_number FROM complete c
     JOIN pending p ON p.chunk_index=c.chunk_index
     ORDER BY c.row_number ASC`,
  )
    .bind(
      userId,
      conversationId,
      relationshipId,
      before.position,
      before.position,
      before.id,
      HISTORY_CHUNK_SIZE,
      HISTORY_CHUNK_SIZE,
      HISTORY_CHUNK_SIZE,
      HISTORY_CHUNK_SIZE,
      userId,
      relationshipId,
      conversationId,
      MAX_HISTORY_CHUNKS,
    )
    .all<HistoryMessageRow>();
  const chunks = new Map<number, EvidenceRef[]>();
  for (const row of rows.results) {
    const index = Math.floor((row.row_number - 1) / HISTORY_CHUNK_SIZE);
    const chunk = chunks.get(index) ?? [];
    chunk.push({ conversationId, messageId: row.id, content: row.content });
    chunks.set(index, chunk);
  }
  const staged: MemoryRow[] = [];
  for (const refs of chunks.values()) {
    if (refs.length !== HISTORY_CHUNK_SIZE) continue;
    const content = refs
      .map(({ content: source }) => `[用户原文片段] ${source.slice(0, 300)}`)
      .join('\n');
    const row = await insertReviewableExcerpt(
      env,
      userId,
      relationshipId,
      refs,
      '较早对话的用户原文分段摘录（待核对）',
      content,
      'history',
      1,
      1,
      now,
    );
    if (row) staged.push(row);
  }
  return staged;
}
