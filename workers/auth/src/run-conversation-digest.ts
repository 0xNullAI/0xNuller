import { saveConversationDigest } from './conversation-digest';
import { arkConfig } from './ark-client';
import {
  generateConversationDigest,
  type DigestSourceMessage,
} from './conversation-digest-generation';
import type { AutoMemoryEnv } from './auto-memory';

interface Candidate {
  user_id: string;
  conversation_id: string;
  relationship_id: string;
  consent_version: number;
  revision: number;
  digest_version: number;
  through_position: number;
  previous_summary: string;
}
interface Source extends DigestSourceMessage {
  position: number;
}

async function suppressedSourceMessageIds(
  env: AutoMemoryEnv,
  candidate: Candidate,
): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT source_conversation_id,source_message_ids,source_refs FROM personal_memories
     WHERE user_id=? AND (relationship_id IS NULL OR relationship_id=?)
       AND (deleted_at IS NOT NULL OR superseded_by_id IS NOT NULL)`,
  )
    .bind(candidate.user_id, candidate.relationship_id)
    .all<{
      source_conversation_id: string | null;
      source_message_ids: string | null;
      source_refs: string | null;
    }>();
  const ids = new Set<string>();
  const parse = (raw: string | null): unknown => {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  for (const row of rows.results) {
    const messageIds = parse(row.source_message_ids);
    if (row.source_conversation_id === candidate.conversation_id && Array.isArray(messageIds))
      for (const id of messageIds) if (typeof id === 'string') ids.add(id);
    const refs = parse(row.source_refs);
    if (Array.isArray(refs))
      for (const ref of refs as Array<{ conversationId?: unknown; messageId?: unknown }>)
        if (ref?.conversationId === candidate.conversation_id && typeof ref.messageId === 'string')
          ids.add(ref.messageId);
  }
  return ids;
}

/** One bounded, opt-in private conversation segment per minute. */
export async function runConversationDigest(env: AutoMemoryEnv, now = Date.now()): Promise<number> {
  const ark = arkConfig(env);
  if (!ark) return 0;
  const candidate = await env.DB.prepare(
    `SELECT c.user_id,c.id AS conversation_id,r.id AS relationship_id,p.version AS consent_version,c.revision,
      COALESCE(d.version,0) AS digest_version,
      COALESCE(d.through_position,-1) AS through_position,
      COALESCE(d.summary,'') AS previous_summary
     FROM server_conversations c
     JOIN character_relationships r ON r.user_id=c.user_id
       AND r.id=json_extract(c.metadata,'$.relationshipId')
       AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
     JOIN conversation_digest_preferences p ON p.user_id=r.user_id
       AND p.relationship_id=r.id AND p.enabled=1
     JOIN users u ON u.id=c.user_id AND u.banned_at IS NULL
     LEFT JOIN conversation_digests d ON d.user_id=c.user_id AND d.conversation_id=c.id
     LEFT JOIN conversation_digest_attempts a ON a.user_id=c.user_id AND a.conversation_id=c.id
     WHERE c.deleted_at IS NULL AND r.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.user_id=c.user_id)
       AND (a.due_at IS NULL OR (a.due_at<=? AND (a.lease_until IS NULL OR a.lease_until<=?)))
       AND EXISTS (
         SELECT 1 FROM server_conversation_messages m
         WHERE m.user_id=c.user_id AND m.conversation_id=c.id
           AND m.position>COALESCE(d.through_position,-1)
           AND m.role IN ('user','assistant') AND m.kind='message'
         ORDER BY m.position DESC,m.id DESC LIMIT 1 OFFSET 20
       )
     -- Prefer conversations with no digest, then the least recently digested.
     -- An active long chat must not monopolize the single bounded cron slot.
     ORDER BY COALESCE(d.updated_at,0) ASC,c.updated_at DESC,c.id ASC LIMIT 1`,
  )
    .bind(now, now)
    .first<Candidate>();
  if (!candidate) return 0;
  const lease = now + 90_000;
  const claimed = await env.DB.prepare(
    `INSERT INTO conversation_digest_attempts(user_id,conversation_id,due_at,lease_until,attempts)
     VALUES(?,?,?,?,0) ON CONFLICT(user_id,conversation_id) DO UPDATE SET
       lease_until=excluded.lease_until
     WHERE conversation_digest_attempts.due_at<=?
       AND (conversation_digest_attempts.lease_until IS NULL
         OR conversation_digest_attempts.lease_until<=?)
     RETURNING attempts`,
  )
    .bind(candidate.user_id, candidate.conversation_id, now, lease, now, now)
    .first<{ attempts: number }>();
  if (!claimed) return 0;
  try {
    const olderThanRecent = await env.DB.prepare(
      `SELECT position,id FROM (
         SELECT position,id FROM server_conversation_messages
         WHERE user_id=? AND conversation_id=? AND role IN ('user','assistant') AND kind='message'
         ORDER BY position DESC,id DESC LIMIT 20
       ) ORDER BY position ASC,id ASC LIMIT 1`,
    )
      .bind(candidate.user_id, candidate.conversation_id)
      .first<{ position: number; id: string }>();
    if (!olderThanRecent) return 0;
    const batch = await env.DB.prepare(
      `SELECT id,role,substr(content,1,900) AS content,position
       FROM server_conversation_messages
       WHERE user_id=? AND conversation_id=? AND role IN ('user','assistant') AND kind='message'
         AND position>?
         AND (position<? OR (position=? AND id<?))
       ORDER BY position ASC,id ASC LIMIT 16`,
    )
      .bind(
        candidate.user_id,
        candidate.conversation_id,
        candidate.through_position,
        olderThanRecent.position,
        olderThanRecent.position,
        olderThanRecent.id,
      )
      .all<Source>();
    const sources = batch.results;
    if (!sources.length) return 0;
    // A source edit can invalidate the prior digest without changing the
    // conversation revision (for example, an independent retention job).
    // Recheck both before private text or a stale summary leaves this Worker.
    const stillAllowed = await env.DB.prepare(
      `SELECT 1 FROM server_conversations c
       JOIN character_relationships r ON r.user_id=c.user_id
         AND r.id=json_extract(c.metadata,'$.relationshipId')
         AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
       JOIN conversation_digest_preferences p ON p.user_id=r.user_id
         AND p.relationship_id=r.id AND p.enabled=1
       JOIN users u ON u.id=c.user_id AND u.banned_at IS NULL
       WHERE c.user_id=? AND c.id=? AND c.revision=? AND c.deleted_at IS NULL
         AND r.id=? AND r.deleted_at IS NULL AND p.version=?
         AND NOT EXISTS(SELECT 1 FROM account_deletions x WHERE x.user_id=c.user_id)
         AND EXISTS(SELECT 1 FROM conversation_digest_attempts a
           WHERE a.user_id=c.user_id AND a.conversation_id=c.id AND a.lease_until=?)
         AND COALESCE((SELECT d.version FROM conversation_digests d
           WHERE d.user_id=c.user_id AND d.conversation_id=c.id),0)=?
         AND COALESCE((SELECT d.summary FROM conversation_digests d
           WHERE d.user_id=c.user_id AND d.conversation_id=c.id),'')=?
         AND NOT EXISTS(
           SELECT 1 FROM json_each(?) source
           LEFT JOIN server_conversation_messages checked
             ON checked.user_id=c.user_id AND checked.conversation_id=c.id
             AND checked.id=json_extract(source.value,'$.id')
           WHERE checked.id IS NULL OR checked.role<>json_extract(source.value,'$.role')
             OR checked.kind<>'message'
             OR checked.position<>json_extract(source.value,'$.position')
             OR substr(checked.content,1,900)<>json_extract(source.value,'$.content'))`,
    )
      .bind(
        candidate.user_id,
        candidate.conversation_id,
        candidate.revision,
        candidate.relationship_id,
        candidate.consent_version,
        lease,
        candidate.digest_version,
        candidate.previous_summary,
        JSON.stringify(sources),
      )
      .first();
    if (!stillAllowed) return 0;
    // Messages that produced a memory the user deleted or replaced are not
    // summarized again; otherwise the rebuilt digest would bring it back.
    const suppressed = await suppressedSourceMessageIds(env, candidate);
    const modelSources = sources.filter((source) => !suppressed.has(source.id));
    const summary = modelSources.length
      ? await generateConversationDigest(
          ark.key,
          ark.table.background,
          candidate.previous_summary,
          modelSources,
        )
      : candidate.previous_summary;
    const last = sources.at(-1)!;
    if (
      !(await saveConversationDigest(env, {
        userId: candidate.user_id,
        conversationId: candidate.conversation_id,
        relationshipId: candidate.relationship_id,
        expectedRevision: candidate.revision,
        expectedVersion: candidate.digest_version,
        throughPosition: last.position,
        throughMessageId: last.id,
        summary,
        now,
        requireOptIn: true,
        expectedConsentVersion: candidate.consent_version,
        memoryUnchangedSince: now,
        sourceChecks: sources.map(({ id, role, content, position }) => ({
          id,
          role,
          content,
          position,
        })),
      }))
    )
      return 0;
    return 1;
  } catch {
    const backoff = Math.min(24 * 3600_000, 60_000 * 2 ** claimed.attempts);
    await env.DB.prepare(
      `UPDATE conversation_digest_attempts SET attempts=attempts+1,due_at=?,lease_until=NULL
       WHERE user_id=? AND conversation_id=? AND lease_until=?`,
    )
      .bind(now + backoff, candidate.user_id, candidate.conversation_id, lease)
      .run();
    return 0;
  } finally {
    // Keep a backoff record after provider failure; successful or stale work
    // releases its lease so the next segment can be discovered.
    await env.DB.prepare(
      `DELETE FROM conversation_digest_attempts WHERE user_id=? AND conversation_id=?
       AND lease_until=?`,
    )
      .bind(candidate.user_id, candidate.conversation_id, lease)
      .run();
  }
}
