import { err, json, readBodyBounded } from './http';
import { currentUser, sha256Hex, type SessionEnv } from './session-domain';
import { MEMORY_COLUMNS, memoryView, type MemoryRow } from './memory-records';
import { stageConversationHistoryMemories, stageSegmentedMemory } from './segmented-memory';
import { matchedMemoryPeople } from './memory-facts';
import { readConversationDigest } from './conversation-digest';

const PATH = '/api/auth/memory-context';
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
interface SourceMessage {
  id: string;
  role: string;
  content: string;
  created_at: number;
  position: number;
}
interface Candidate {
  kind: string;
  title: string;
  content: string;
  tier: string;
  sources: string[];
}

const CJK = /^[\u3400-\u9fff]+$/;
// These are conversational glue and question words, not facts. Splitting before
// bigramming prevents "小林的" from outranking "小林 ... 面试" for an interview query.
const QUERY_GLUE =
  /什么时候|怎么样|星期几|是不是|有没有|请问|告诉我|记得|记住|上次|之前|关于|说过|提过|聊过|那个|这个|这件事|什么|怎么|如何|哪里|哪天|多少|是否|后来|现在|最近|之行|可以|我的|你的|他的|她的|我们|你们|他们|她们|的|了|吗|呢|啊|呀|是/gu;
const COMMON_PREFIX_WORDS = new Set([
  '小孩',
  '小朋',
  '小时',
  '小说',
  '小学',
  '小区',
  '小组',
  '小心',
  '小事',
  '小猫',
  '小狗',
  '小鸟',
  '小鱼',
  '小型',
  '小额',
  '小于',
  '阿姨',
  '阿婆',
  '阿公',
  '阿爸',
  '阿妈',
  '阿哥',
  '阿弟',
]);

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function queryTerms(query: string): string[] {
  const content = normalized(query).replace(QUERY_GLUE, ' ');
  const terms = new Set<string>();
  for (const chunk of content.match(/[a-z0-9]{2,}|[\u3400-\u9fff]+/gu) ?? []) {
    if (CJK.test(chunk)) {
      if (chunk.length === 1) continue;
      for (let index = 0; index < chunk.length - 1; index++)
        terms.add(chunk.slice(index, index + 2));
    } else {
      terms.add(chunk);
    }
    if (terms.size >= 50) break;
  }
  return [...terms];
}

/** A limited explicit nickname shape is a hard lexical constraint, not person recognition or alias resolution. */
function queryNames(query: string): string[] {
  const names = normalized(query).match(/[小阿][\u3400-\u9fff]/gu) ?? [];
  return [...new Set(names.filter((name) => !COMMON_PREFIX_WORDS.has(name)))];
}

/** Inverted ownership questions need an explicit first-person source, not a friend's matching pet. */
function invertedOwnershipObject(query: string): string | null {
  return (
    /^([\u3400-\u9fff]{1,2})是我养的(?:吗|么)?[？?。！!]*$/u.exec(normalized(query.trim()))?.[1] ??
    null
  );
}

function statesFirstPersonOwnership(text: string, object: string): boolean {
  // `object` contains only one or two CJK characters from the anchored query above.
  return new RegExp(`(?:^|[\\s。！？；;])我(?:没有|没|有|曾经|以前|现在)?养${object}`, 'u').test(
    text,
  );
}

/** A request to continue needs the latest sourced context even without search terms. */
function continuationQuery(query: string): boolean {
  return /^(?:继续|继续说|接着|接着说|接上次|说下去|上次聊到哪|我们上次聊到哪|刚才说到哪)[。！!？?\s]*$/u.test(
    query.trim(),
  );
}

/** A narrow answerable shape for short first-person action/object questions. */
function firstPersonObjectQuestion(query: string) {
  const match =
    /^我(?<time>现在|最近|目前|如今|以前|过去|曾经)?(?<action>喝|吃|养)什么(?<object>[\u3400-\u9fff]{1,2})[？?。！!]*$/u.exec(
      normalized(query.trim()),
    );
  if (!match?.groups) return null;
  return {
    time: match.groups.time ?? '',
    action: match.groups.action!,
    object: match.groups.object!,
  };
}

function directFirstPersonObjectEvidence(
  text: string,
  question: NonNullable<ReturnType<typeof firstPersonObjectQuestion>>,
) {
  const time = question.time;
  const expectedTime = /^(?:以前|过去|曾经)$/u.test(time)
    ? '(?:以前|过去|曾经)'
    : time
      ? '(?:现在|最近|目前|如今)'
      : '(?:现在|最近|目前|如今|以前|过去|曾经)?';
  // The object and action come only from the anchored one/two-character query.
  // A direct first-person statement is required; “我的朋友喝茶”, “我给朋友
  // 买茶”, and “朋友说我喝茶” are not assertions about the user's habit.
  return new RegExp(
    `(?:^|[\\s。！？；;])我${expectedTime}(?:改|开始|仍然|每天|经常|常常|不再|没有|没|有)?${question.action}[\\u3400-\\u9fff]{0,3}${question.object}(?:$|[\\s，。！？；;])`,
    'u',
  ).test(text);
}

/** Bounded local retrieval after D1 has enforced ownership, scope, state and expiry. */
function selectContext(
  rows: MemoryRow[],
  query: string,
  tier: string,
  people: Map<string, string[]>,
) {
  const scoped = rows.filter((row) => row.tier === tier);
  const trimmed = query.trim();
  const terms = queryTerms(trimmed);
  const invertedObject = invertedOwnershipObject(trimmed);
  const names = queryNames(trimmed);
  const objectQuestion = firstPersonObjectQuestion(trimmed);
  const queryAliases = [...people.values()].flat();
  const topicalTerms = terms.filter(
    (term) =>
      !names.some((name) => name.includes(term)) &&
      !queryAliases.some((alias) => alias.includes(term)),
  );
  const askingForName = /(?:名字|别名|叫什么|称呼|又名)/u.test(trimmed);
  const commonPrefixWords = (normalized(trimmed).match(/[小阿][\u3400-\u9fff]/gu) ?? []).filter(
    (word) => COMMON_PREFIX_WORDS.has(word),
  );
  const documents = scoped.map((row) => ({ row, text: normalized(`${row.title} ${row.content}`) }));
  const personHasTopic = new Set(
    documents
      .filter(
        ({ row, text }) =>
          row.person_id !== null && topicalTerms.some((term) => text.includes(term)),
      )
      .map(({ row }) => row.person_id),
  );
  const weights = terms.map((term) => {
    const frequency = documents.filter(({ text }) => text.includes(term)).length;
    // Query-only cross-word bigrams are common in Chinese questions. They
    // should not outweigh the words that actually occur in a sourced memory.
    return frequency ? 1 + Math.log((documents.length + 1) / (frequency + 1)) : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const ranked = documents
    .map(({ row, text }) => {
      const personMatches = row.person_id !== null && people.has(row.person_id);
      // A fact linked to a different resolved person must not ride in on shared topic words.
      if (people.size > 0 && row.person_id !== null && !personMatches) return { row, score: 0 };
      // Identity is a scope hint, not proof that this fact answers every question
      // about the person. Require the subject matter too, except for bare-name
      // lookups and explicit questions about the person's other names.
      if (
        (people.size || names.length) &&
        topicalTerms.length &&
        !topicalTerms.some((term) => text.includes(term))
      ) {
        const aliasEvidence = /(?:也叫|又叫|又名|别名|本名)/u.test(text);
        if (!(
          aliasEvidence &&
          (askingForName || (personMatches && personHasTopic.has(row.person_id)))
        ))
          return { row, score: 0 };
      }
      // “阿姨的面试” must not become “小王的面试” merely because the
      // occupation/event term matches. The same word can still match literally.
      if (commonPrefixWords.length && !commonPrefixWords.some((word) => text.includes(word)))
        return { row, score: 0 };
      if (invertedObject && !statesFirstPersonOwnership(text, invertedObject))
        return { row, score: 0 };
      const nameMatches = names.length === 0 || names.some((name) => text.includes(name));
      const directObjectMatch =
        objectQuestion !== null && directFirstPersonObjectEvidence(text, objectQuestion);
      if (objectQuestion && !directObjectMatch) return { row, score: 0 };
      const score =
        nameMatches || personMatches
          ? terms.reduce(
              (sum, term, index) => sum + (text.includes(term) ? weights[index]! : 0),
              0,
            ) +
            (personMatches ? totalWeight + 1 : 0) +
            (invertedObject ? totalWeight + 1 : 0) +
            (directObjectMatch ? totalWeight + 1 : 0)
          : 0;
      const coverage = totalWeight ? score / totalWeight : 0;
      // With no explicit nickname, a lone common word from a longer question
      // is too weak to supply a supposed personal fact to the model.
      return {
        row,
        score: !personMatches && !names.length && terms.length > 1 && coverage < 0.5 ? 0 : score,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updated_at - a.row.updated_at ||
        a.row.id.localeCompare(b.row.id),
    );
  let remaining = tier === 'long' ? 8000 : 4000;
  return ranked
    .filter(({ row, score }) => {
      if (trimmed && score === 0) return false;
      const size = row.title.length + row.content.length;
      if (size > remaining) return false;
      remaining -= size;
      return true;
    })
    .slice(0, 8)
    .map(({ row }) => memoryView(row));
}
function candidates(messages: SourceMessage[]): Candidate[] {
  const users = messages.filter((message) => message.role === 'user');
  const result: Candidate[] = [];
  const recent = users.slice(-8);
  if (recent.length)
    result.push({
      kind: 'note',
      title: '近期对话原文摘录（待核对）',
      tier: 'medium',
      content: recent
        .map(
          (message) =>
            `[用户原文] ${message.content.slice(0, 300)}${message.content.length > 300 ? '…（截取）' : ''}`,
        )
        .join('\n'),
      sources: recent.map((message) => message.id),
    });
  for (const message of users.slice(-50).reverse()) {
    const match = /^(?:请)?(记住|我们约定)[：:]\s*([\s\S]{1,4000})$/.exec(message.content.trim());
    if (!match || !match[2]?.trim()) continue;
    const history = match[1] === '我们约定';
    result.push({
      kind: history ? 'event' : 'note',
      title: history ? '用户提出的约定（待确认）' : '用户请求记住的内容（待确认）',
      tier: history ? 'history' : 'long',
      content: match[2].trim(),
      sources: [message.id],
    });
    if (result.length >= 6) break;
  }
  return result;
}

/** Retrieve exact older user excerpts for this conversation, never inferred facts or assistant claims. */
async function olderConversationExcerpts(
  env: SessionEnv,
  userId: string,
  conversationId: string,
  before: Pick<SourceMessage, 'position' | 'id'>,
  query: string,
) {
  const continuation = continuationQuery(query);
  const terms = continuation ? [] : queryTerms(query).slice(0, 8);
  if (!terms.length && !continuation) return [];
  const names = queryNames(query);
  const matches = terms.map(() => 'instr(lower(m.content),?)>0').join(' OR ');
  // Apply explicit names before the recent-match cap. Otherwise dozens of
  // newer messages about the same topic can evict the older named source.
  const namedMatches = names.map(() => 'instr(lower(m.content),?)>0').join(' OR ');
  const matchPosition = continuation
    ? '1'
    : `CASE ${terms.map(() => 'WHEN instr(lower(m.content),?)>0 THEN instr(lower(m.content),?)').join(' ')} ELSE 1 END`;
  const rows = await env.DB.prepare(
    `SELECT id,substr(content,max(1,match_position-100),1000) AS content,
       (length(content)>1000 OR match_position>101) AS truncated
     FROM (
       SELECT m.id,m.content,m.position,${matchPosition} AS match_position
       FROM server_conversation_messages m
       JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
       WHERE m.user_id=? AND m.conversation_id=? AND c.deleted_at IS NULL
         AND m.role='user' AND m.kind='message'
         AND (m.position<? OR (m.position=? AND m.id<?))
         ${continuation ? '' : `AND (${matches})`}
         ${names.length ? `AND (${namedMatches})` : ''}
     ) ORDER BY position DESC,id DESC LIMIT 48`,
  )
    .bind(
      ...terms.flatMap((term) => [term, term]),
      userId,
      conversationId,
      before.position,
      before.position,
      before.id,
      ...terms,
      ...names,
    )
    .all<{ id: string; content: string; truncated: number }>();
  return rows.results
    .filter((row) => !names.length || names.some((name) => normalized(row.content).includes(name)))
    .map((row) => ({
      row,
      score: terms.reduce(
        (score, term) => score + (normalized(row.content).includes(term) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ row }) => {
      const text = normalized(row.content);
      const matchingTerm = terms.find((term) => text.includes(term));
      const position = matchingTerm ? text.indexOf(matchingTerm) : 0;
      const start = Math.max(0, position - 100);
      return {
        id: row.id,
        content: row.content.slice(start, start + 500),
        truncated: row.truncated === 1 || start > 0 || row.content.length > start + 500,
      };
    });
}

/** Source access and scope are derived from owned server conversations, never trusted from a request. */
export async function handleMemoryContext(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== PATH && path !== `${PATH}/suggestions`) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id)
    return err('账号已切换，请重新打开记忆', 403, headers);
  if (user.banned_at !== null) return err('账号不可用', 403, headers);
  if (request.method !== 'POST') return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, 5000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body');
    body = parsed as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  if (
    Object.keys(body).some((key) => !['conversationId', 'query'].includes(key)) ||
    typeof body.conversationId !== 'string' ||
    !ID.test(body.conversationId) ||
    (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 1000))
  )
    return err('会话或检索条件无效', 400, headers);
  const conversationId = body.conversationId;
  const source = await env.DB.prepare(
    `SELECT r.id AS relationship_id, c.revision,
      COALESCE((SELECT version FROM conversation_account_memory_access a
        WHERE a.user_id=c.user_id AND a.conversation_id=c.id),0) AS access_version
     FROM server_conversations c JOIN character_relationships r
     ON r.user_id=c.user_id AND r.id=json_extract(c.metadata,'$.relationshipId')
     AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
     WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL`,
  )
    .bind(user.id, conversationId)
    .first<{ relationship_id: string; revision: number; access_version: number }>();
  if (!source) return err('会话不存在、尚未绑定私人关系或已删除', 404, headers);
  const relationshipId = source.relationship_id;
  const messages = await env.DB.prepare(
    `SELECT m.id,m.role,m.content,m.created_at,m.position FROM server_conversation_messages m
     JOIN server_conversations c ON c.user_id=m.user_id AND c.id=m.conversation_id
     WHERE m.user_id=? AND m.conversation_id=? AND c.deleted_at IS NULL
       AND m.role IN ('user','assistant') AND m.kind='message'
     ORDER BY m.position DESC,m.id DESC LIMIT 50`,
  )
    .bind(user.id, conversationId)
    .all<SourceMessage>();
  const ordered = messages.results.reverse();
  if (path.endsWith('/suggestions')) {
    const now = Date.now();
    const items = [];
    for (const candidate of candidates(ordered)) {
      const id = `derived-${(await sha256Hex(`${user.id}:${relationshipId}:${conversationId}:${candidate.tier}:${candidate.sources.join(',')}`)).slice(0, 48)}`;
      const row = await env.DB.prepare(
        `INSERT INTO personal_memories(user_id,id,kind,title,content,version,created_at,updated_at,scope,relationship_id,tier,state,source_conversation_id,source_message_ids,expires_at)
         SELECT ?,?,?,?,?,1,?,?,'relationship',?,?,'suggested',?,?,? WHERE
         EXISTS(SELECT 1 FROM server_conversations c JOIN character_relationships r ON r.user_id=c.user_id AND r.id=?
          WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND r.deleted_at IS NULL
          AND json_extract(c.metadata,'$.relationshipId')=r.id AND json_extract(c.metadata,'$.promptPresetId')=r.character_id)
         AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN server_conversation_messages m
          ON m.user_id=? AND m.conversation_id=? AND m.id=json_extract(expected.value,'$.id')
          WHERE m.id IS NULL OR m.role<>'user' OR m.kind<>'message'
            OR m.content<>json_extract(expected.value,'$.content'))
         AND (SELECT COUNT(*) FROM personal_memories WHERE user_id=? AND deleted_at IS NULL)<200
         ON CONFLICT(user_id,id) DO NOTHING RETURNING ${MEMORY_COLUMNS}`,
      )
        .bind(
          user.id,
          id,
          candidate.kind,
          candidate.title,
          candidate.content,
          now,
          now,
          relationshipId,
          candidate.tier,
          conversationId,
          JSON.stringify(candidate.sources),
          candidate.tier === 'medium' ? now + 30 * 86400_000 : null,
          relationshipId,
          user.id,
          conversationId,
          JSON.stringify(
            ordered
              .filter((message) => candidate.sources.includes(message.id))
              .map(({ id, content }) => ({ id, content })),
          ),
          user.id,
          conversationId,
          user.id,
        )
        .first<MemoryRow>();
      if (row) items.push(memoryView(row));
    }
    const segmented = await stageSegmentedMemory(env, user.id, relationshipId, now);
    if (segmented) items.push(memoryView(segmented));
    if (ordered.length > 12) {
      const history = await stageConversationHistoryMemories(
        env,
        user.id,
        relationshipId,
        conversationId,
        ordered[ordered.length - 12]!,
        now,
      );
      items.push(...history.map(memoryView));
    }
    return json(
      {
        items,
        generated: items.length,
        notice: '原文摘录和候选尚未用于长期记忆；请核对是否为真实经历后确认。',
      },
      200,
      headers,
    );
  }
  const rows = await env.DB.prepare(
    `SELECT ${MEMORY_COLUMNS} FROM personal_memories WHERE user_id=? AND deleted_at IS NULL AND state='active'
     AND superseded_by_id IS NULL
     AND (expires_at IS NULL OR expires_at>?) AND (
       (scope='relationship' AND relationship_id=?) OR
       (scope='account' AND EXISTS(SELECT 1 FROM conversation_account_memory_access a
         WHERE a.user_id=? AND a.conversation_id=? AND a.enabled=1)))
     ORDER BY updated_at DESC,id ASC LIMIT 200`,
  )
    .bind(user.id, Date.now(), relationshipId, user.id, conversationId)
    .all<MemoryRow>();
  const query = typeof body.query === 'string' ? body.query : '';
  const memoryQuery = continuationQuery(query) ? '' : query;
  const historyRecap =
    ordered.length > 12
      ? await olderConversationExcerpts(
          env,
          user.id,
          conversationId,
          ordered[ordered.length - 12]!,
          query,
        )
      : [];
  const people = await matchedMemoryPeople(env, user.id, relationshipId, memoryQuery);
  const stillAccessible = await env.DB.prepare(
    `SELECT c.id FROM server_conversations c JOIN character_relationships r
    ON r.user_id=c.user_id AND r.id=json_extract(c.metadata,'$.relationshipId')
    WHERE c.user_id=? AND c.id=? AND c.revision=? AND c.deleted_at IS NULL
      AND r.id=? AND r.character_id=json_extract(c.metadata,'$.promptPresetId')
      AND r.deleted_at IS NULL
      AND COALESCE((SELECT version FROM conversation_account_memory_access a
        WHERE a.user_id=c.user_id AND a.conversation_id=c.id),0)=?`,
  )
    .bind(user.id, conversationId, source.revision, relationshipId, source.access_version)
    .first();
  if (!stillAccessible) return err('会话已变更，请重新读取记忆', 409, headers);
  const conversationDigest = await readConversationDigest(
    env,
    user.id,
    conversationId,
    relationshipId,
  );
  return json(
    {
      relationshipId,
      conversationDigest,
      shortTerm: ordered.slice(-12).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content.slice(0, 4000),
        truncated: message.content.length > 4000,
      })),
      historyRecap,
      mediumTerm: selectContext(rows.results, memoryQuery, 'medium', people),
      longTerm: selectContext(rows.results, memoryQuery, 'long', people),
      relationshipHistory: selectContext(rows.results, memoryQuery, 'history', people),
    },
    200,
    headers,
  );
}
