import { useEffect, useRef, useState } from 'react';
import {
  listAgentTasks,
  saveAgentTask,
  deleteAgentTask,
  listConversationFiles,
  readConversationFile,
  uploadConversationFile,
  deleteConversationFile,
  type AgentTask,
  type ConversationTextFile,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';
import { readTextUpload } from './read-text-upload';
export function AgentWorkspacePanel({ conversationId }: { conversationId: string }) {
  return <Workspace key={conversationId} conversationId={conversationId} />;
}
const STATUS = { planned: '待开始', active: '进行中', paused: '暂停', completed: '已完成' };
function Workspace({ conversationId }: { conversationId: string }) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [files, setFiles] = useState<ConversationTextFile[] | null>(null);
  const [editing, setEditing] = useState<AgentTask | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState('');
  const [steps, setSteps] = useState('');
  const [status, setStatus] = useState<AgentTask['status']>('planned');
  const [preview, setPreview] = useState<ConversationTextFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([listAgentTasks(conversationId), listConversationFiles(conversationId)])
      .then(([plans, documents]) => {
        if (active) {
          setTasks(plans.items);
          setFiles(documents.items);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '读取失败');
      });
    return () => {
      active = false;
    };
  }, [conversationId, reload]);
  const loaded = tasks !== null && files !== null;
  function refresh() {
    setTasks(null);
    setFiles(null);
    setError('');
    setReload((value) => value + 1);
  }
  function clear() {
    setEditing(null);
    setDraftId(crypto.randomUUID());
    setTitle('');
    setSteps('');
    setStatus('planned');
  }
  async function run(action: () => Promise<void>) {
    if (busy || !loaded) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save(input: Pick<AgentTask, 'id' | 'title' | 'steps' | 'status' | 'version'>) {
    const { item } = await saveAgentTask(conversationId, input);
    if (!alive.current) return;
    setTasks((current) => [item, ...(current ?? []).filter((task) => task.id !== item.id)]);
    setNotice('计划已保存；状态不代表外部操作已执行');
  }
  return (
    <section
      aria-label="会话工作区"
      className="space-y-4 rounded border border-[var(--surface-border)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">会话工作区</h3>
        <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>
          刷新工作区
        </Button>
      </div>
      <p className="text-xs text-[var(--text-soft)]">
        计划和资料仅属于当前私人会话。AI
        可以阅读文件、整理待确认记忆和协助安排步骤；计划完成记录不等于已执行外部操作。
      </p>
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {!loaded ? (
        <p className="text-xs">{error ? '暂时无法读取工作区，请刷新重试' : '正在读取工作区…'}</p>
      ) : (
        <>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {tasks.map((task) => (
              <article
                key={task.id}
                className="space-y-2 rounded border border-[var(--surface-border)] p-2"
              >
                <p className="break-words text-sm font-medium">
                  {task.title} · {STATUS[task.status]}
                </p>
                {task.steps.map((step) => (
                  <label key={step.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={step.status === 'done'}
                      onChange={() =>
                        void run(async () => {
                          const next = task.steps.map((s) =>
                            s.id === step.id
                              ? {
                                  ...s,
                                  status:
                                    s.status === 'done' ? ('pending' as const) : ('done' as const),
                                }
                              : s,
                          );
                          await save({
                            ...task,
                            steps: next,
                            status: next.every((s) => s.status !== 'pending')
                              ? 'completed'
                              : task.status === 'completed'
                                ? 'active'
                                : task.status,
                          });
                        })
                      }
                    />
                    <span className="break-words">
                      {step.title}
                      {step.status === 'skipped' ? '（已跳过）' : ''}
                    </span>
                  </label>
                ))}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`编辑计划 ${task.title}`}
                    onClick={() => {
                      setEditing(task);
                      setTitle(task.title);
                      setSteps(task.steps.map((step) => step.title).join('\n'));
                      setStatus(task.status);
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`删除计划 ${task.title}`}
                    onClick={() =>
                      void run(async () => {
                        await deleteAgentTask(conversationId, task.id, task.version);
                        if (!alive.current) return;
                        setTasks((current) => current?.filter((t) => t.id !== task.id) ?? []);
                        if (editing?.id === task.id) clear();
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const lines = steps
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
                if (lines.length < 1 || lines.length > 20)
                  throw new Error('请填写 1–20 个步骤，每行一步');
                await save({
                  id: editing?.id ?? draftId,
                  version: editing?.version ?? 0,
                  title,
                  status,
                  steps: lines.map((line, index) => ({
                    id: editing?.steps[index]?.id ?? crypto.randomUUID(),
                    title: line,
                    status: editing?.steps[index]?.status ?? 'pending',
                  })),
                });
                if (alive.current) clear();
              });
            }}
          >
            <Input
              aria-label="任务计划标题"
              value={title}
              maxLength={200}
              disabled={busy}
              placeholder="计划名称"
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="任务计划步骤"
              value={steps}
              disabled={busy}
              rows={4}
              placeholder="每行一个步骤，最多 20 步"
              onChange={(event) => setSteps(event.target.value)}
              className="w-full rounded border border-[var(--surface-border)] bg-transparent p-2 text-sm"
            />
            <label className="text-sm">
              计划状态
              <select
                aria-label="计划状态"
                value={status}
                disabled={busy}
                onChange={(event) => setStatus(event.target.value as AgentTask['status'])}
                className="ml-2 rounded border bg-transparent p-1"
              >
                {Object.entries(STATUS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !title.trim() || !steps.trim()}>
                保存计划
              </Button>
              {editing && (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={clear}>
                  取消编辑
                </Button>
              )}
            </div>
          </form>
          <div className="space-y-2 border-t border-[var(--surface-border)] pt-3">
            <p className="text-sm font-medium">当前会话文件</p>
            <p className="text-xs text-[var(--text-soft)]">
              支持 UTF-8 .txt/.md，单个最多 64 KiB，每会话最多 20
              个。文件内容作为引用资料，不作为系统指令执行。
            </p>
            <input
              aria-label="上传文本或 Markdown"
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              disabled={busy}
              className="max-w-full text-xs"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file)
                  void run(async () => {
                    const parsed = await readTextUpload(file);
                    const { item } = await uploadConversationFile(conversationId, {
                      id: crypto.randomUUID(),
                      ...parsed,
                    });
                    if (alive.current) setFiles((current) => [item, ...(current ?? [])]);
                  });
              }}
            />
            {files.map((file) => (
              <div key={file.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 break-all">
                  {file.name} · {file.byteLength} 字节
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`查看文件 ${file.name}`}
                  onClick={() =>
                    void run(async () => {
                      const { item } = await readConversationFile(conversationId, file.id);
                      if (alive.current) setPreview(item);
                    })
                  }
                >
                  查看
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`删除文件 ${file.name}`}
                  onClick={() =>
                    void run(async () => {
                      await deleteConversationFile(conversationId, file.id, file.version);
                      if (!alive.current) return;
                      setFiles((current) => current?.filter((f) => f.id !== file.id) ?? []);
                      if (preview?.id === file.id) setPreview(null);
                    })
                  }
                >
                  删除
                </Button>
              </div>
            ))}
            {preview && (
              <div>
                <p className="text-xs font-medium">{preview.name}</p>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--surface-border)] p-2 text-xs">
                  {preview.content}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
