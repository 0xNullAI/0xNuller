import { useEffect, useRef, useState } from 'react';
import {
  deletePersonalMemory,
  getAccountMemoryAccess,
  getAutoMemorySettings,
  getConversationDigestPreference,
  listPersonalMemories,
  savePersonalMemory,
  setAccountMemoryAccess,
  setAutoMemorySettings,
  setConversationDigestPreference,
  suggestConversationMemories,
  type AutoMemorySettings,
  type ConversationDigestPreference,
  type AccountMemoryAccess,
  type PersonalMemory,
  type PersonalMemoryKind,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';
import { AdvancedSettings } from './AdvancedSettings';
import {
  notifyRelationshipMemoryChanged,
  subscribeRelationshipMemoryChanged,
} from './relationship-memory-events';

export interface MemoryReviewPanelProps {
  relationshipId: string;
  conversationId?: string;
}
const TIERS = { long: '长期记忆', medium: '中期对话摘录', history: '关系经历与约定' };
const KINDS = { note: '事实或备注', preference: '个人偏好', person: '重要的人', event: '事件' };
function memorySources(item: PersonalMemory): Array<{ conversationId: string; messageId: string }> {
  if (item.sourceRefs?.length) return item.sourceRefs;
  if (!item.sourceConversationId) return [];
  return (item.sourceMessageIds ?? []).map((messageId) => ({
    conversationId: item.sourceConversationId!,
    messageId,
  }));
}
/** Parent keys by account id. All records stay inside the selected private relationship. */
export function MemoryReviewPanel(props: MemoryReviewPanelProps) {
  return (
    <MemoryReviewEditor key={`${props.relationshipId}:${props.conversationId ?? ''}`} {...props} />
  );
}
function MemoryReviewEditor({ relationshipId, conversationId }: MemoryReviewPanelProps) {
  const [items, setItems] = useState<PersonalMemory[] | null>(null);
  const [accountAccess, setAccountAccess] = useState<AccountMemoryAccess | null>(null);
  const [accessError, setAccessError] = useState('');
  const [accessReload, setAccessReload] = useState(0);
  const [autoSettings, setAutoSettings] = useState<AutoMemorySettings | null>(null);
  const [autoError, setAutoError] = useState('');
  const [digestSettings, setDigestSettings] = useState<ConversationDigestPreference | null>(null);
  const [digestError, setDigestError] = useState('');
  const [editing, setEditing] = useState<PersonalMemory | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<PersonalMemoryKind>('note');
  const [tier, setTier] = useState<'long' | 'medium' | 'history'>('long');
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
    void listPersonalMemories(relationshipId)
      .then(({ items: records }) => {
        if (active) setItems(records);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '读取失败');
      });
    return () => {
      active = false;
    };
  }, [relationshipId, reload]);
  useEffect(() => {
    let active = true;
    void getConversationDigestPreference(relationshipId)
      .then((settings) => {
        if (active) {
          setDigestSettings(settings);
          setDigestError('');
        }
      })
      .catch((cause: unknown) => {
        if (active) setDigestError(cause instanceof Error ? cause.message : '读取摘要设置失败');
      });
    return () => {
      active = false;
    };
  }, [relationshipId]);
  useEffect(
    () =>
      subscribeRelationshipMemoryChanged(relationshipId, () => {
        setItems(null);
        setReload((n) => n + 1);
      }),
    [relationshipId],
  );
  useEffect(() => {
    let active = true;
    if (!conversationId) return;
    void getAccountMemoryAccess(conversationId)
      .then((access) => {
        if (active) {
          setAccountAccess(access);
          setAccessError('');
        }
      })
      .catch((cause: unknown) => {
        if (active) setAccessError(cause instanceof Error ? cause.message : '读取记忆开放设置失败');
      });
    return () => {
      active = false;
    };
  }, [conversationId, accessReload]);
  useEffect(() => {
    let active = true;
    void getAutoMemorySettings(relationshipId)
      .then((settings) => {
        if (active) {
          setAutoSettings(settings);
          setAutoError('');
        }
      })
      .catch((cause: unknown) => {
        if (active) setAutoError(cause instanceof Error ? cause.message : '读取自动记忆设置失败');
      });
    return () => {
      active = false;
    };
  }, [relationshipId, reload]);
  function clear() {
    setEditing(null);
    setDraftId(crypto.randomUUID());
    setTitle('');
    setContent('');
    setKind('note');
    setTier('long');
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
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
  async function save(item?: PersonalMemory) {
    if (items === null) return;
    await run(async () => {
      const result = await savePersonalMemory({
        id: item?.id ?? editing?.id ?? draftId,
        version: item?.version ?? editing?.version ?? 0,
        kind: item?.kind ?? kind,
        title: item?.title ?? title,
        content: item?.content ?? content,
        scope: 'relationship',
        relationshipId,
        tier: item?.tier ?? tier,
        state: 'active',
      });
      if (!alive.current) return;
      setItems((previous) => [
        result.item,
        ...(previous ?? []).filter((record) => record.id !== result.item.id),
      ]);
      notifyRelationshipMemoryChanged(relationshipId);
      if (!item || editing?.id === item.id) clear();
      setNotice('已确认记忆，可用于这段私人关系的后续对话');
    });
  }
  async function remove(item: PersonalMemory) {
    if (items === null) return;
    await run(async () => {
      await deletePersonalMemory(item.id, item.version);
      if (!alive.current) return;
      setItems((previous) => previous?.filter((record) => record.id !== item.id) ?? []);
      notifyRelationshipMemoryChanged(relationshipId);
      if (editing?.id === item.id) clear();
      setNotice(
        item.state === 'suggested'
          ? '已拒绝候选；相同来源不会自动重新生成'
          : '已删除；相同来源不会自动重新生成',
      );
    });
  }
  return (
    <section
      aria-label="关系记忆"
      className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
    >
      <p className="text-xs text-[var(--text-soft)]">只属于你和这个角色；确认后才会被 AI 使用。</p>
      <div className="space-y-2 rounded-lg bg-[var(--bg-soft)] p-3">
        <p className="text-sm font-medium">本聊天可见的个人资料</p>
        <p className="text-xs text-[var(--text-soft)]">账号级记忆默认不开放，可只对本聊天开放。</p>
        {conversationId && accountAccess ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={accountAccess.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(async () => {
                  const saved = await setAccountMemoryAccess(
                    conversationId,
                    enabled,
                    accountAccess.version,
                  );
                  if (!alive.current) return;
                  setAccountAccess(saved);
                  setNotice(enabled ? '已对本聊天开放账号记忆' : '本聊天已停止读取账号记忆');
                });
              }}
            />
            允许本聊天读取账号级记忆
          </label>
        ) : (
          <p className="text-xs text-[var(--text-faint)]">
            {accessError
              ? '当前未开放账号记忆。'
              : conversationId
                ? '正在读取本聊天的开放设置…'
                : '开始聊天后可单独选择开放范围。'}
          </p>
        )}
        {accessError && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-xs text-[var(--danger)]">
              {accessError}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAccessError('');
                setAccessReload((value) => value + 1);
              }}
            >
              重试读取
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2 rounded-lg bg-[var(--bg-soft)] p-3">
        <p className="text-sm font-medium">自动发现待确认记忆</p>
        <p className="text-xs text-[var(--text-soft)]">开启后用 MiniMax 分析消息，确认后才保存。</p>
        {autoSettings ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoSettings.item.enabled}
              disabled={busy || (!autoSettings.available && !autoSettings.item.enabled)}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(async () => {
                  const result = await setAutoMemorySettings(
                    relationshipId,
                    enabled,
                    autoSettings.item.version,
                  );
                  if (!alive.current) return;
                  setAutoSettings(result);
                  setNotice(
                    enabled ? '已开启；新候选稍后出现在这里，确认前不会使用' : '已关闭自动分析',
                  );
                });
              }}
            />
            允许自动分析这段关系的用户消息
          </label>
        ) : (
          <p className="text-xs">正在读取自动记忆设置…</p>
        )}
        {autoSettings?.item.enabled && autoSettings.progress && (
          <p className="text-xs text-[var(--text-soft)]" role="status">
            {autoSettings.progress.queued > 0
              ? `待处理 ${autoSettings.progress.queued} 段会话${autoSettings.progress.retrying ? `，其中 ${autoSettings.progress.retrying} 段重试中` : ''}`
              : '当前没有待处理的会话'}
            {autoSettings.progress.paused > 0
              ? `；${autoSettings.progress.paused} 段因连续失败暂停，请联系管理员核对服务。`
              : ''}
          </p>
        )}
        {autoSettings && !autoSettings.available && (
          <p className="text-xs text-[var(--text-faint)]">服务暂未配置，当前无法开启。</p>
        )}
        {autoError && (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {autoError}
          </p>
        )}
        {autoSettings?.item.enabled && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            刷新候选
          </Button>
        )}
      </div>
      {conversationId && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || items === null}
          onClick={() =>
            void run(async () => {
              const result = await suggestConversationMemories(conversationId);
              if (!alive.current) return;
              setNotice(
                result.generated
                  ? `新增 ${result.generated} 条待核对内容`
                  : '没有新的候选；已有或已删除的来源不会重复生成',
              );
              setItems(null);
              setReload((value) => value + 1);
            })
          }
        >
          整理近期对话
        </Button>
      )}
      {error && (
        <div role="alert" className="text-sm text-[var(--danger)]">
          {error}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setError('');
              setItems(null);
              setReload((value) => value + 1);
            }}
          >
            重新读取
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {items === null ? (
        <p className="text-xs">{error ? '暂时无法读取记忆' : '正在读取记忆…'}</p>
      ) : (
        <>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {items.length === 0 && <p className="text-xs">还没有这段关系的记忆。</p>}
            {items.map((item) => (
              <article
                key={item.id}
                className="space-y-1 rounded border border-[var(--surface-border)] p-2"
              >
                <p className="break-words text-sm font-medium">{item.title}</p>
                <p className="text-xs text-[var(--text-soft)]">
                  {TIERS[item.tier ?? 'long']} ·{' '}
                  {item.effectiveState === 'superseded'
                    ? '已被新事实替代，不再用于回答'
                    : item.state === 'suggested'
                      ? '待核对，尚未用于记忆'
                      : '已确认'}
                  {item.expiresAt ? ` · ${new Date(item.expiresAt).toLocaleDateString()} 到期` : ''}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">{item.content}</p>
                {memorySources(item).length > 0 ? (
                  <div className="text-xs text-[var(--text-soft)]">
                    <p>来源</p>
                    <ul className="break-all">
                      {memorySources(item).map((source) => (
                        <li key={`${source.conversationId}:${source.messageId}`}>
                          {source.conversationId === conversationId ? '当前聊天' : '其他聊天'} ·
                          会话 {source.conversationId} · 消息 {source.messageId}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--text-soft)]">
                    来源：用户手动保存，无聊天消息引用。
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {item.state === 'suggested' && (
                    <Button size="sm" disabled={busy} onClick={() => void save(item)}>
                      确认是真实记忆
                    </Button>
                  )}
                  {item.effectiveState !== 'superseded' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`编辑 ${item.title}`}
                      onClick={() => {
                        setEditing(item);
                        setTitle(item.title);
                        setContent(item.content);
                        setKind(item.kind);
                        setTier(item.tier ?? 'long');
                      }}
                    >
                      编辑
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${item.state === 'suggested' ? '拒绝候选' : '删除'} ${item.title}`}
                    onClick={() => void remove(item)}
                  >
                    {item.state === 'suggested' ? '拒绝候选' : '删除'}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-sm">{editing ? '修改后确认记忆' : '手动记下真实信息'}</p>
            <label className="block text-sm">
              内容类型
              <select
                aria-label="内容类型"
                disabled={busy}
                value={kind}
                onChange={(event) => setKind(event.target.value as PersonalMemoryKind)}
                className="ml-2 rounded border bg-transparent p-1"
              >
                {Object.entries(KINDS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="关系记忆标题"
              value={title}
              maxLength={100}
              disabled={busy}
              placeholder="标题"
              onChange={(event) => setTitle(event.target.value)}
            />
            <textarea
              aria-label="关系记忆内容"
              value={content}
              maxLength={4000}
              disabled={busy}
              rows={3}
              onChange={(event) => setContent(event.target.value)}
              className="w-full rounded border border-[var(--surface-border)] bg-transparent p-2 text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !title.trim() || !content.trim()}>
                保存并确认
              </Button>
              {editing && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={clear}>
                  取消编辑
                </Button>
              )}
            </div>
          </form>
        </>
      )}
      <AdvancedSettings>
        <div className="space-y-2">
          <label className="block text-sm font-medium">
            记忆层级
            <select
              aria-label="记忆层级"
              disabled={busy}
              value={tier}
              onChange={(event) => setTier(event.target.value as typeof tier)}
              className="ml-2 rounded border bg-transparent p-1"
            >
              {Object.entries(TIERS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium">长对话概述</h4>
          <p className="text-xs text-[var(--text-soft)]">
            开启后用 MiniMax 压缩较早聊天，不算长期记忆；关闭会删除已有概述。
          </p>
          {digestSettings ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={digestSettings.item.enabled}
                disabled={busy || (!digestSettings.available && !digestSettings.item.enabled)}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(async () => {
                    const result = await setConversationDigestPreference(
                      relationshipId,
                      enabled,
                      digestSettings.item.version,
                    );
                    if (alive.current) setDigestSettings(result);
                  });
                }}
              />
              允许压缩这段关系的较早聊天
            </label>
          ) : (
            <p className="text-xs">正在读取摘要设置…</p>
          )}
          {digestSettings && !digestSettings.available && (
            <p className="text-xs text-[var(--text-faint)]">服务暂未配置，当前无法开启。</p>
          )}
          {digestError && (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {digestError}
            </p>
          )}
        </div>
      </AdvancedSettings>
    </section>
  );
}
