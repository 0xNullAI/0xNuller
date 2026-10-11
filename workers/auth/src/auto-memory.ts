import { err, json, readBodyBounded } from './http';
import { generateMemoryCandidates, type MemorySource } from './minimax-memory';
import { currentUser, sha256Hex, type SessionEnv } from './session-domain';

const PATH = '/api/auth/auto-memory/';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_ATTEMPTS = 5;

export interface AutoMemoryEnv extends SessionEnv {
  MINIMAX_MEDIA_API_KEY?: string;
}

interface PreferenceRow {
  enabled: number;
  version: number;
  updated_at: number;
}

interface QueueSummaryRow {
  queued: number;
  retrying: number;
  paused: number;
}

async function queueSummary(env: AutoMemoryEnv, userId: string, relationshipId: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS queued,
       COALESCE(SUM(CASE WHEN j.attempts>0 AND j.attempts<? THEN 1 ELSE 0 END),0) AS retrying,
       COALESCE(SUM(CASE WHEN j.attempts>=? THEN 1 ELSE 0 END),0) AS paused
     FROM memory_extraction_jobs j
     JOIN server_conversations c ON c.user_id=j.user_id AND c.id=j.conversation_id
     JOIN character_relationships r ON r.user_id=c.user_id
       AND r.id=json_extract(c.metadata,'$.relationshipId')
       AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
     WHERE j.user_id=? AND r.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL`,
  )
    .bind(MAX_ATTEMPTS, MAX_ATTEMPTS, userId, relationshipId)
    .first<QueueSummaryRow>();
  return { queued: row?.queued ?? 0, retrying: row?.retrying ?? 0, paused: row?.paused ?? 0 };
}

function preferenceView(row: PreferenceRow | null) {
  return {
    enabled: row?.enabled === 1,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
  };
}

/** Opt-in is scoped to one owned private relationship. Existing users start disabled. */
export async function handleAutoMemory(
  request: Request,
  env: AutoMemoryEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PATH)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const relationshipId = path.slice(PATH.length);
  if (!ID.test(relationshipId)) return err('关系编号无效', 400, headers);
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at !== null) return err('账号不可用', 403, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id)
    return err('账号已切换，请重新打开记忆', 403, headers);

  const relationship = await env.DB.prepare(
    'SELECT id FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(user.id, relationshipId)
    .first();
  if (!relationship) return err('关系不存在或已删除', 404, headers);
  const available = Boolean(env.MINIMAX_MEDIA_API_KEY?.trim());
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT enabled,version,updated_at FROM relationship_memory_preferences WHERE user_id=? AND relationship_id=?',
    )
      .bind(user.id, relationshipId)
      .first<PreferenceRow>();
    return json(
      {
        item: preferenceView(row),
        available,
        progress: await queueSummary(env, user.id, relationshipId),
      },
      200,
      headers,
    );
  }
  if (request.method !== 'PUT') return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 1000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body');
    body = value as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  if (
    Object.keys(body).some((key) => key !== 'enabled' && key !== 'version') ||
    typeof body.enabled !== 'boolean' ||
    typeof body.version !== 'number' ||
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  )
    return err('自动记忆设置无效', 400, headers);
  if (body.enabled && !available) return err('自动记忆服务暂不可用', 503, headers);
  const now = Date.now();
  const row =
    body.version === 0
      ? await env.DB.prepare(
          `INSERT INTO relationship_memory_preferences(user_id,relationship_id,enabled,version,updated_at)
           SELECT ?,?,?,1,? WHERE EXISTS (
             SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL
           ) ON CONFLICT DO NOTHING RETURNING enabled,version,updated_at`,
        )
          .bind(user.id, relationshipId, body.enabled ? 1 : 0, now, user.id, relationshipId)
          .first<PreferenceRow>()
      : await env.DB.prepare(
          `UPDATE relationship_memory_preferences SET enabled=?,version=version+1,updated_at=?
           WHERE user_id=? AND relationship_id=? AND version=?
           AND EXISTS(SELECT 1 FROM character_relationships WHERE user_id=? AND id=? AND deleted_at IS NULL)
           RETURNING enabled,version,updated_at`,
        )
          .bind(
            body.enabled ? 1 : 0,
            now,
            user.id,
            relationshipId,
            body.version,
            user.id,
            relationshipId,
          )
          .first<PreferenceRow>();
  if (!row) return err('设置已变更，请刷新后重试', 409, headers);

  if (body.enabled) {
    // Consent covers this relationship's existing conversations. The minute cron
    // processes one bounded message batch per run, so old chats are not skipped.
    await env.DB.prepare(
      `INSERT INTO memory_extraction_jobs(user_id,conversation_id,generation,due_at)
       SELECT c.user_id,c.id,1,? FROM server_conversations c
       JOIN character_relationships r ON r.user_id=c.user_id
         AND r.id=json_extract(c.metadata,'$.relationshipId')
         AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
       WHERE c.user_id=? AND r.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
         AND EXISTS(SELECT 1 FROM server_conversation_messages m
           WHERE m.user_id=c.user_id AND m.conversation_id=c.id
             AND m.role='user' AND m.kind='message' AND length(m.content) BETWEEN 4 AND 1000)
       ORDER BY c.updated_at DESC
       ON CONFLICT(user_id,conversation_id) DO UPDATE SET
         generation=generation+1,due_at=excluded.due_at,lease_until=NULL,attempts=0,last_error=NULL`,
    )
      .bind(now + 30_000, user.id, relationshipId)
      .run();
  } else {
    await env.DB.prepare(
      `DELETE FROM memory_extraction_jobs WHERE user_id=? AND conversation_id IN (
        SELECT id FROM server_conversations WHERE user_id=?
          AND json_extract(metadata,'$.relationshipId')=?)`,
    )
      .bind(user.id, user.id, relationshipId)
      .run();
    await env.DB.prepare(
      `DELETE FROM memory_extraction_progress WHERE user_id=? AND conversation_id IN (
        SELECT id FROM server_conversations WHERE user_id=?
          AND json_extract(metadata,'$.relationshipId')=?)`,
    )
      .bind(user.id, user.id, relationshipId)
      .run();
  }
  return json(
    {
      item: preferenceView(row),
      available,
      progress: await queueSummary(env, user.id, relationshipId),
    },
    200,
    headers,
  );
}

interface JobRow {
  user_id: string;
  conversation_id: string;
  generation: number;
  lease_until: number | null;
  attempts: number;
}
interface ProgressRow {
  relationship_id: string;
  last_position: number;
  last_id: string;
}
interface PositionedMemorySource extends MemorySource {
  position: number;
}

/** Minute cron. Every insertion rechecks opt-in, source text, ownership and the job lease. */
export async function runAutoMemory(env: AutoMemoryEnv, now = Date.now()): Promise<number> {
  const key = env.MINIMAX_MEDIA_API_KEY?.trim();
  if (!key) return 0;
  const due = await env.DB.prepare(
    `SELECT user_id,conversation_id,generation,lease_until,attempts FROM memory_extraction_jobs
     WHERE due_at<=? AND (lease_until IS NULL OR lease_until<=?) AND attempts<?
     ORDER BY due_at ASC LIMIT 1`,
  )
    .bind(now, now, MAX_ATTEMPTS)
    .all<JobRow>();
  let completed = 0;
  for (const candidateJob of due.results) {
    const lease = now + 90_000;
    const job = await env.DB.prepare(
      `UPDATE memory_extraction_jobs SET lease_until=? WHERE user_id=? AND conversation_id=?
       AND generation=? AND due_at<=? AND (lease_until IS NULL OR lease_until<=?) AND attempts<?
       RETURNING user_id,conversation_id,generation,lease_until,attempts`,
    )
      .bind(
        lease,
        candidateJob.user_id,
        candidateJob.conversation_id,
        candidateJob.generation,
        now,
        now,
        MAX_ATTEMPTS,
      )
      .first<JobRow>();
    if (!job) continue;
    let attempted: { relationshipId: string; last: PositionedMemorySource } | null = null;
    try {
      const relation = await env.DB.prepare(
        `SELECT r.id FROM server_conversations c
         JOIN character_relationships r ON r.user_id=c.user_id
           AND r.id=json_extract(c.metadata,'$.relationshipId')
           AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
         JOIN relationship_memory_preferences p ON p.user_id=r.user_id
           AND p.relationship_id=r.id AND p.enabled=1
         JOIN users u ON u.id=c.user_id AND u.banned_at IS NULL
         WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
           AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id)`,
      )
        .bind(job.user_id, job.conversation_id)
        .first<{ id: string }>();
      if (relation) {
        const progress = await env.DB.prepare(
          `SELECT relationship_id,last_position,last_id FROM memory_extraction_progress
           WHERE user_id=? AND conversation_id=?`,
        )
          .bind(job.user_id, job.conversation_id)
          .first<ProgressRow>();
        const cursor = progress?.relationship_id === relation.id ? progress : null;
        const messages = await env.DB.prepare(
          `SELECT id,content,position FROM server_conversation_messages
           WHERE user_id=? AND conversation_id=? AND role='user' AND kind='message'
             AND length(content) BETWEEN 4 AND 1000
             AND (position>? OR (position=? AND id>?))
           ORDER BY position ASC,id ASC LIMIT 16`,
        )
          .bind(
            job.user_id,
            job.conversation_id,
            cursor?.last_position ?? -1,
            cursor?.last_position ?? -1,
            cursor?.last_id ?? '',
          )
          .all<PositionedMemorySource>();
        const sources = messages.results;
        // Preferences can be disabled while the source query runs. Recheck the
        // current lease and opt-in immediately before sending private text to
        // the provider; the insertion below independently rechecks after it.
        const mayExtract = await env.DB.prepare(
          `SELECT 1 FROM memory_extraction_jobs j
           JOIN server_conversations c ON c.user_id=j.user_id AND c.id=j.conversation_id
           JOIN character_relationships r ON r.user_id=c.user_id
             AND r.id=json_extract(c.metadata,'$.relationshipId')
             AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
           JOIN relationship_memory_preferences p ON p.user_id=r.user_id
             AND p.relationship_id=r.id AND p.enabled=1
           JOIN users u ON u.id=j.user_id AND u.banned_at IS NULL
           WHERE j.user_id=? AND j.conversation_id=? AND j.generation=? AND j.lease_until=?
             AND c.deleted_at IS NULL AND r.deleted_at IS NULL
             AND (SELECT COUNT(*) FROM personal_memories m
               WHERE m.user_id=j.user_id AND m.deleted_at IS NULL)<200
             AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id)`,
        )
          .bind(job.user_id, job.conversation_id, job.generation, lease)
          .first();
        if (mayExtract && sources.length) {
          attempted = { relationshipId: relation.id, last: sources.at(-1)! };
          const candidates = await generateMemoryCandidates(
            key,
            sources.map(({ id, content }) => ({ id, content })),
          );
          for (const candidate of candidates) {
            const source = sources.find((item) => item.id === candidate.sourceId);
            if (!source) continue;
            const id = `auto-${(await sha256Hex(`${job.user_id}:${relation.id}:${job.conversation_id}:${candidate.sourceId}:${candidate.kind}`)).slice(0, 48)}`;
            await env.DB.prepare(
              `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,
              scope,relationship_id,tier,state,source_conversation_id,source_message_ids)
             SELECT ?,?,?,?,?,1,?,?,'relationship',?,?,'suggested',?,?
             WHERE EXISTS(SELECT 1 FROM memory_extraction_jobs j WHERE j.user_id=? AND j.conversation_id=?
               AND j.generation=? AND j.lease_until=?)
             AND EXISTS(SELECT 1 FROM server_conversations c
               JOIN character_relationships r ON r.user_id=c.user_id
                 AND r.id=json_extract(c.metadata,'$.relationshipId')
                 AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
               JOIN relationship_memory_preferences p ON p.user_id=r.user_id
                 AND p.relationship_id=r.id AND p.enabled=1
               JOIN users u ON u.id=c.user_id AND u.banned_at IS NULL
               JOIN server_conversation_messages m ON m.user_id=c.user_id AND m.conversation_id=c.id
               WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND r.id=? AND r.deleted_at IS NULL
                 AND m.id=? AND m.role='user' AND m.kind='message' AND m.content=?
                 AND NOT EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=u.id))
             AND (SELECT COUNT(*) FROM personal_memories WHERE user_id=? AND deleted_at IS NULL)<200
             ON CONFLICT(user_id,id) DO NOTHING`,
            )
              .bind(
                job.user_id,
                id,
                candidate.kind,
                candidate.title.trim(),
                candidate.content.trim(),
                now,
                now,
                relation.id,
                candidate.tier,
                job.conversation_id,
                JSON.stringify([candidate.sourceId]),
                job.user_id,
                job.conversation_id,
                job.generation,
                lease,
                job.user_id,
                job.conversation_id,
                relation.id,
                candidate.sourceId,
                source.content,
                job.user_id,
              )
              .run();
          }
          const last = sources.at(-1);
          if (last) {
            const advanced = await env.DB.prepare(
              `INSERT INTO memory_extraction_progress
               (user_id,conversation_id,relationship_id,last_position,last_id)
               SELECT ?,?,?,?,? WHERE EXISTS(
                 SELECT 1 FROM memory_extraction_jobs j
                 JOIN server_conversations c ON c.user_id=j.user_id AND c.id=j.conversation_id
                 JOIN character_relationships r ON r.user_id=c.user_id
                   AND r.id=json_extract(c.metadata,'$.relationshipId')
                   AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
                 JOIN relationship_memory_preferences p ON p.user_id=r.user_id
                   AND p.relationship_id=r.id AND p.enabled=1
                 WHERE j.user_id=? AND j.conversation_id=? AND j.generation=?
                   AND j.lease_until=? AND c.deleted_at IS NULL AND r.id=? AND r.deleted_at IS NULL)
               ON CONFLICT(user_id,conversation_id) DO UPDATE SET
                 relationship_id=excluded.relationship_id,
                 last_position=excluded.last_position,last_id=excluded.last_id
               RETURNING last_position`,
            )
              .bind(
                job.user_id,
                job.conversation_id,
                relation.id,
                last.position,
                last.id,
                job.user_id,
                job.conversation_id,
                job.generation,
                lease,
                relation.id,
              )
              .first<{ last_position: number }>();
            if (!advanced) continue;
            const more = await env.DB.prepare(
              `SELECT 1 FROM server_conversation_messages WHERE user_id=? AND conversation_id=?
               AND role='user' AND kind='message' AND length(content) BETWEEN 4 AND 1000
               AND (position>? OR (position=? AND id>?)) LIMIT 1`,
            )
              .bind(job.user_id, job.conversation_id, last.position, last.position, last.id)
              .first();
            if (more) {
              await env.DB.prepare(
                `UPDATE memory_extraction_jobs SET due_at=?,lease_until=NULL,attempts=0
                 WHERE user_id=? AND conversation_id=? AND generation=? AND lease_until=?`,
              )
                .bind(now + 60_000, job.user_id, job.conversation_id, job.generation, lease)
                .run();
              completed++;
              continue;
            }
          }
        }
      }
      await env.DB.prepare(
        `DELETE FROM memory_extraction_jobs WHERE user_id=? AND conversation_id=? AND generation=? AND lease_until=?`,
      )
        .bind(job.user_id, job.conversation_id, job.generation, lease)
        .run();
      completed++;
    } catch {
      if (attempted && job.attempts + 1 >= MAX_ATTEMPTS) {
        // A batch that keeps failing (for example output the model cannot format) would
        // otherwise block every later message in this conversation and be re-sent, and
        // paid for, after each new message. Skip past it and continue with the rest.
        const skipped = await env.DB.prepare(
          `INSERT INTO memory_extraction_progress
           (user_id,conversation_id,relationship_id,last_position,last_id)
           SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM memory_extraction_jobs
             WHERE user_id=? AND conversation_id=? AND generation=? AND lease_until=?)
           ON CONFLICT(user_id,conversation_id) DO UPDATE SET
             relationship_id=excluded.relationship_id,
             last_position=excluded.last_position,last_id=excluded.last_id
           RETURNING last_position`,
        )
          .bind(
            job.user_id,
            job.conversation_id,
            attempted.relationshipId,
            attempted.last.position,
            attempted.last.id,
            job.user_id,
            job.conversation_id,
            job.generation,
            lease,
          )
          .first();
        if (skipped) {
          await env.DB.prepare(
            `UPDATE memory_extraction_jobs SET attempts=0,due_at=?,lease_until=NULL,
              last_error='batch_skipped' WHERE user_id=? AND conversation_id=? AND generation=? AND lease_until=?`,
          )
            .bind(now + 60_000, job.user_id, job.conversation_id, job.generation, lease)
            .run();
          continue;
        }
      }
      const backoff = Math.min(24 * 3600_000, 60_000 * 2 ** job.attempts);
      await env.DB.prepare(
        `UPDATE memory_extraction_jobs SET attempts=attempts+1,due_at=?,lease_until=NULL,
          last_error='provider_unavailable' WHERE user_id=? AND conversation_id=? AND generation=? AND lease_until=?`,
      )
        .bind(now + backoff, job.user_id, job.conversation_id, job.generation, lease)
        .run();
    }
  }
  return completed;
}
