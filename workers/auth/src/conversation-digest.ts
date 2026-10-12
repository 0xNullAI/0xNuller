import type { SessionEnv } from './session-domain';

export interface ConversationDigest {
  relationshipId: string;
  throughPosition: number;
  throughMessageId: string;
  summary: string;
  version: number;
}

/** Save only a digest generated from the exact conversation revision and source cursor. */
export async function saveConversationDigest(
  env: Pick<SessionEnv, 'DB'>,
  input: {
    userId: string;
    conversationId: string;
    relationshipId: string;
    expectedRevision: number;
    expectedVersion: number;
    throughPosition: number;
    throughMessageId: string;
    summary: string;
    now: number;
    requireOptIn?: boolean;
    expectedConsentVersion?: number;
    /**
     * Reject the save if a memory in this relationship (or account scope) was
     * deleted or replaced at or after this time: the summary may have been
     * generated from it while the delete was invalidating digests.
     */
    memoryUnchangedSince?: number;
    sourceChecks: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      position: number;
    }>;
  },
): Promise<boolean> {
  const summary = input.summary.trim();
  if (
    summary.length > 4000 ||
    input.throughPosition < 0 ||
    (input.requireOptIn &&
      (!Number.isSafeInteger(input.expectedConsentVersion) ||
        (input.expectedConsentVersion ?? 0) < 1)) ||
    !input.sourceChecks.length ||
    input.sourceChecks.length > 16 ||
    input.sourceChecks.at(-1)?.id !== input.throughMessageId ||
    input.sourceChecks.at(-1)?.position !== input.throughPosition
  )
    return false;
  const row = await env.DB.prepare(
    `INSERT INTO conversation_digests
      (user_id,conversation_id,relationship_id,through_position,through_message_id,summary,version,updated_at)
     SELECT ?,?,?,?,?,?,1,? WHERE
       COALESCE((SELECT version FROM conversation_digests
         WHERE user_id=? AND conversation_id=?),0)=?
       AND (?=0 OR EXISTS(SELECT 1 FROM conversation_digest_preferences p
         WHERE p.user_id=? AND p.relationship_id=? AND p.enabled=1 AND p.version=?))
       AND NOT EXISTS (
         SELECT 1 FROM json_each(?) source
         LEFT JOIN server_conversation_messages checked
           ON checked.user_id=? AND checked.conversation_id=?
           AND checked.id=json_extract(source.value,'$.id')
         WHERE checked.id IS NULL OR checked.role<>json_extract(source.value,'$.role')
           OR checked.position<>json_extract(source.value,'$.position')
           OR substr(checked.content,1,900)<>json_extract(source.value,'$.content')
       )
       AND NOT EXISTS (
         SELECT 1 FROM personal_memories pm
         WHERE pm.user_id=? AND (pm.relationship_id IS NULL OR pm.relationship_id=?)
           AND pm.updated_at>=?
           AND (pm.deleted_at IS NOT NULL OR pm.superseded_by_id IS NOT NULL)
       )
       AND EXISTS (
       SELECT 1 FROM server_conversations c
       JOIN character_relationships r ON r.user_id=c.user_id
         AND r.id=json_extract(c.metadata,'$.relationshipId')
         AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
       JOIN server_conversation_messages m ON m.user_id=c.user_id
         AND m.conversation_id=c.id
       JOIN users u ON u.id=c.user_id AND u.banned_at IS NULL
       WHERE c.user_id=? AND c.id=? AND c.revision=? AND c.deleted_at IS NULL
         AND r.id=? AND r.deleted_at IS NULL
         AND m.id=? AND m.position=?
         AND NOT EXISTS(SELECT 1 FROM account_deletions a WHERE a.user_id=u.id)
     )
     ON CONFLICT(user_id,conversation_id) DO UPDATE SET
       relationship_id=excluded.relationship_id,
       through_position=excluded.through_position,
       through_message_id=excluded.through_message_id,
       summary=excluded.summary,
       version=conversation_digests.version+1,
       updated_at=excluded.updated_at
     WHERE conversation_digests.version=?
       AND conversation_digests.relationship_id=excluded.relationship_id
       AND conversation_digests.through_position<excluded.through_position
     RETURNING version`,
  )
    .bind(
      input.userId,
      input.conversationId,
      input.relationshipId,
      input.throughPosition,
      input.throughMessageId,
      summary,
      input.now,
      input.userId,
      input.conversationId,
      input.expectedVersion,
      input.requireOptIn ? 1 : 0,
      input.userId,
      input.relationshipId,
      input.expectedConsentVersion ?? 0,
      JSON.stringify(input.sourceChecks),
      input.userId,
      input.conversationId,
      input.userId,
      input.relationshipId,
      input.memoryUnchangedSince ?? Number.MAX_SAFE_INTEGER,
      input.userId,
      input.conversationId,
      input.expectedRevision,
      input.relationshipId,
      input.throughMessageId,
      input.throughPosition,
      input.expectedVersion,
    )
    .first<{ version: number }>();
  return row !== null && row.version === input.expectedVersion + 1;
}

/** Read only from an active owned relationship; stale source cursors cannot be injected. */
export async function readConversationDigest(
  env: Pick<SessionEnv, 'DB'>,
  userId: string,
  conversationId: string,
  relationshipId: string,
): Promise<ConversationDigest | null> {
  const row = await env.DB.prepare(
    `SELECT d.relationship_id,d.through_position,d.through_message_id,d.summary,d.version
     FROM conversation_digests d
     JOIN server_conversations c ON c.user_id=d.user_id AND c.id=d.conversation_id
     JOIN character_relationships r ON r.user_id=c.user_id
       AND r.id=json_extract(c.metadata,'$.relationshipId')
       AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
     JOIN conversation_digest_preferences p ON p.user_id=r.user_id
       AND p.relationship_id=r.id AND p.enabled=1
     JOIN server_conversation_messages m ON m.user_id=d.user_id
       AND m.conversation_id=d.conversation_id AND m.id=d.through_message_id
     WHERE d.user_id=? AND d.conversation_id=? AND d.relationship_id=?
       AND c.deleted_at IS NULL AND r.id=d.relationship_id AND r.deleted_at IS NULL
       AND m.position=d.through_position`,
  )
    .bind(userId, conversationId, relationshipId)
    .first<{
      relationship_id: string;
      through_position: number;
      through_message_id: string;
      summary: string;
      version: number;
    }>();
  return row
    ? {
        relationshipId: row.relationship_id,
        throughPosition: row.through_position,
        throughMessageId: row.through_message_id,
        summary: row.summary,
        version: row.version,
      }
    : null;
}
