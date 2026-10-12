import { err, json, readBodyBounded } from './http';
import { currentUser, type SessionEnv } from './session-domain';
const TASKS = '/api/auth/agent-tasks';
const FILES = '/api/auth/conversation-files';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_FILE_BYTES = 64 * 1024;
interface Step {
  id: string;
  title: string;
  status: 'pending' | 'done' | 'skipped';
}
interface TaskRow {
  id: string;
  conversation_id: string;
  title: string;
  steps_json: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
}
interface FileRow {
  id: string;
  conversation_id: string;
  name: string;
  mime: string;
  byte_length: number;
  version: number;
  created_at: number;
  content?: string;
}
const TASK_COLUMNS = 'id,conversation_id,title,steps_json,status,version,created_at,updated_at';
const FILE_COLUMNS = 'id,conversation_id,name,mime,byte_length,version,created_at';
function taskView(row: TaskRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    steps: JSON.parse(row.steps_json) as Step[],
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function fileView(row: FileRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    mime: row.mime,
    byteLength: row.byte_length,
    version: row.version,
    createdAt: row.created_at,
    ...(row.content === undefined ? {} : { content: row.content }),
  };
}
function stepsOf(raw: unknown): Step[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return null;
  const seen = new Set<string>();
  const result: Step[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const step = value as Record<string, unknown>;
    if (
      Object.keys(step).some((key) => !['id', 'title', 'status'].includes(key)) ||
      typeof step.id !== 'string' ||
      !ID.test(step.id) ||
      seen.has(step.id) ||
      typeof step.title !== 'string' ||
      !step.title.trim() ||
      step.title.length > 300 ||
      !['pending', 'done', 'skipped'].includes(String(step.status))
    )
      return null;
    if (typeof step.status !== 'string') return null;
    seen.add(step.id);
    result.push({ id: step.id, title: step.title.trim(), status: step.status as Step['status'] });
  }
  return result;
}
export async function handleAgentWorkspace(
  request: Request,
  env: SessionEnv,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const files = path === FILES || path.startsWith(`${FILES}/`);
  const base = files ? FILES : TASKS;
  if (path !== base && !path.startsWith(`${base}/`)) return null;
  const headers = { ...cors, 'Cache-Control': 'no-store' };
  const user = await currentUser(request, env);
  if (!user) return err('请先登录', 401, headers);
  if (user.banned_at != null) return err('账号不可用', 403, headers);
  const account = request.headers.get('X-Account-Id');
  if (account !== null && account !== user.id)
    return err('账号已切换，请重新打开工作区', 403, headers);
  const id = path === base ? null : path.slice(base.length + 1);
  if (id !== null && !ID.test(id)) return err('编号无效', 400, headers);
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId || !CONVERSATION_ID.test(conversationId))
    return err('必须指定当前会话', 400, headers);
  const active = await env.DB.prepare(
    'SELECT id FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL',
  )
    .bind(user.id, conversationId)
    .first();
  if (!active) return err('会话不存在或已删除', 404, headers);
  const table = files ? 'conversation_text_files' : 'agent_tasks';
  const columns = files ? FILE_COLUMNS : TASK_COLUMNS;
  if (request.method === 'GET') {
    const query = env.DB.prepare(
      `SELECT ${columns}${files && id ? ',content' : ''} FROM ${table} WHERE user_id=? AND conversation_id=? AND deleted_at IS NULL ${id ? 'AND id=?' : ''} AND EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL) ORDER BY created_at DESC,id ASC LIMIT 100`,
    );
    const rows = await query
      .bind(user.id, conversationId, ...(id ? [id] : []), user.id, conversationId)
      .all<TaskRow & FileRow>();
    const items = rows.results.map((row) => (files ? fileView(row) : taskView(row)));
    return id
      ? items[0]
        ? json({ item: items[0] }, 200, headers)
        : err('内容不存在或已删除', 404, headers)
      : json({ items }, 200, headers);
  }
  if (!id || !['PUT', 'DELETE'].includes(request.method)) return err('不支持此操作', 405, headers);
  const bytes = await readBodyBounded(request, files ? 400_000 : 20_000);
  if (!bytes) return err('内容过大', 413, headers);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body');
    body = value as Record<string, unknown>;
  } catch {
    return err('请求格式无效', 400, headers);
  }
  const fields =
    request.method === 'DELETE'
      ? ['version']
      : files
        ? ['version', 'name', 'mime', 'content']
        : ['version', 'title', 'steps', 'status'];
  if (
    Object.keys(body).some((key) => !fields.includes(key)) ||
    typeof body.version !== 'number' ||
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  )
    return err('字段或版本无效', 400, headers);
  const version = body.version;
  const now = Date.now();
  if (request.method === 'DELETE') {
    const clear = files
      ? "name='',content='',byte_length=0"
      : "title='',steps_json='[]',updated_at=?";
    const row = await env.DB.prepare(
      `UPDATE ${table} SET ${clear},deleted_at=?,version=version+1 WHERE user_id=? AND id=? AND conversation_id=? AND version=? AND deleted_at IS NULL RETURNING id`,
    )
      .bind(...(files ? [] : [now]), now, user.id, id, conversationId, version)
      .first();
    return row ? json({ ok: true }, 200, headers) : err('内容已变更或删除，请刷新', 409, headers);
  }
  if (files) {
    const { name, mime, content } = body;
    if (version !== 0) return err('文件不可覆盖，请上传新文件或删除旧文件', 409, headers);
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 120 ||
      /[\\/]/.test(name) ||
      !/^.+\.(txt|md|markdown)$/i.test(name) ||
      !['text/plain', 'text/markdown'].includes(String(mime)) ||
      typeof mime !== 'string' ||
      typeof content !== 'string' ||
      content.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(content)
    )
      return err('只支持 UTF-8 纯文本或 Markdown 文件', 400, headers);
    const byteLength = new TextEncoder().encode(content).byteLength;
    if (byteLength > MAX_FILE_BYTES) return err('文本文件最多 64 KiB', 413, headers);
    const row = await env.DB.prepare(
      `INSERT INTO conversation_text_files(user_id,id,conversation_id,name,mime,content,byte_length,version,created_at)
   SELECT ?,?,?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL)
   AND (SELECT COUNT(*) FROM conversation_text_files WHERE user_id=? AND conversation_id=? AND deleted_at IS NULL)<20
   ON CONFLICT(user_id,id) DO NOTHING RETURNING ${FILE_COLUMNS}`,
    )
      .bind(
        user.id,
        id,
        conversationId,
        name.trim(),
        mime,
        content,
        byteLength,
        now,
        user.id,
        conversationId,
        user.id,
        conversationId,
      )
      .first<FileRow>();
    return row
      ? json({ item: fileView(row) }, 201, headers)
      : err('文件已存在、会话已删除或达到 20 个文件上限', 409, headers);
  }
  const steps = stepsOf(body.steps);
  const { title, status } = body;
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 200 ||
    typeof status !== 'string' ||
    !['planned', 'active', 'paused', 'completed'].includes(status) ||
    !steps ||
    (status === 'completed' && steps.some((step) => step.status === 'pending'))
  )
    return err('计划标题、步骤或状态无效；完成计划不能含待办步骤', 400, headers);
  const row =
    version === 0
      ? await env.DB.prepare(
          `INSERT INTO agent_tasks(user_id,id,conversation_id,title,steps_json,status,version,created_at,updated_at)
  SELECT ?,?,?,?,?,?,1,?,? WHERE EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM agent_tasks WHERE user_id=? AND conversation_id=? AND deleted_at IS NULL)<100
  ON CONFLICT(user_id,id) DO NOTHING RETURNING ${TASK_COLUMNS}`,
        )
          .bind(
            user.id,
            id,
            conversationId,
            title.trim(),
            JSON.stringify(steps),
            status,
            now,
            now,
            user.id,
            conversationId,
            user.id,
            conversationId,
          )
          .first<TaskRow>()
      : await env.DB.prepare(
          `UPDATE agent_tasks SET title=?,steps_json=?,status=?,version=version+1,updated_at=? WHERE user_id=? AND id=? AND conversation_id=? AND version=? AND deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL) RETURNING ${TASK_COLUMNS}`,
        )
          .bind(
            title.trim(),
            JSON.stringify(steps),
            status,
            now,
            user.id,
            id,
            conversationId,
            version,
            user.id,
            conversationId,
          )
          .first<TaskRow>();
  return row
    ? json(
        { item: taskView(row), notice: '计划状态记录不代表外部动作已执行' },
        version === 0 ? 201 : 200,
        headers,
      )
    : err('计划已变更、已删除或达到上限，请刷新后重试', 409, headers);
}
