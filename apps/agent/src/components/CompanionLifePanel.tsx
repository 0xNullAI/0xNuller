import { useEffect, useRef, useState } from 'react';
import {
  listCompanionLife,
  saveCompanionLife,
  deleteCompanionLife,
  type CompanionLifeRecord,
  type CompanionLifeKind,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';
const KINDS = {
  person: '重要的人',
  event: '生活事件',
  milestone: '共同经历',
  lifecycle: '关系阶段',
};
const STAGES = {
  getting_to_know: '初识',
  established: '熟悉',
  reconnecting: '重新联系',
  paused: '暂停联系',
  ended: '结束关系',
};
export function CompanionLifePanel({
  accountId,
  relationshipId,
}: {
  accountId: string;
  relationshipId: string;
}) {
  return <LifeEditor key={`${accountId}:${relationshipId}`} relationshipId={relationshipId} />;
}
function LifeEditor({ relationshipId }: { relationshipId: string }) {
  const [items, setItems] = useState<CompanionLifeRecord[] | null>(null);
  const [editing, setEditing] = useState<CompanionLifeRecord | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<CompanionLifeKind>('person');
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [date, setDate] = useState('');
  const [personIds, setPersonIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void listCompanionLife(relationshipId)
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '读取失败');
      });
    return () => {
      active = false;
    };
  }, [relationshipId, reload]);
  function clear() {
    setEditing(null);
    setDraftId(crypto.randomUUID());
    setKind('person');
    setTitle('');
    setLabel('');
    setContent('');
    setDate('');
    setPersonIds([]);
  }
  function edit(item: CompanionLifeRecord) {
    setEditing(item);
    setKind(item.kind);
    setTitle(item.title);
    setLabel(item.label);
    setContent(item.content);
    setDate(item.occurredOn ?? '');
    setPersonIds(item.personIds);
  }
  async function run(operation: () => Promise<unknown>) {
    if (locked.current || items === null) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
      if (!mounted.current) return;
      clear();
      setItems(null);
      setReload((v) => v + 1);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      if (mounted.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  const stage = items?.find((i) => i.kind === 'lifecycle');
  return (
    <section aria-label="人物与共同经历" className="space-y-3 text-sm">
      <p>
        记录你主动告诉 AI
        的重要人物、生活事件和共同经历。仅用于这段私人关系，不会读取通讯录或他人的朋友圈。
      </p>
      <p>
        关系阶段：{stage ? STAGES[stage.label as keyof typeof STAGES] : '尚未设置'}{' '}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || items === null}
          onClick={() => {
            if (stage) edit(stage);
            else {
              clear();
              setKind('lifecycle');
              setTitle('我们的关系');
              setLabel('getting_to_know');
            }
          }}
        >
          设置阶段
        </Button>
      </p>
      {error && (
        <div role="alert">
          {error}{' '}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setError('');
              setItems(null);
              setReload((v) => v + 1);
            }}
          >
            重新读取
          </Button>
        </div>
      )}
      {items === null && <p role="status">正在读取…</p>}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {items
          ?.filter((i) => i.kind !== 'lifecycle')
          .map((item) => (
            <article key={item.id} className="rounded border border-[var(--surface-border)] p-2">
              <p className="font-medium break-words">
                {item.title} · {KINDS[item.kind]}
              </p>
              <p className="text-xs">
                {item.label} {item.occurredOn}
              </p>
              <p className="whitespace-pre-wrap break-words">{item.content}</p>
              {item.personIds.length > 0 && (
                <p className="text-xs">
                  相关人物：
                  {item.personIds
                    .map((id) => items.find((p) => p.id === id)?.title ?? '已删除人物')
                    .join('、')}
                </p>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(item)}>
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() => deleteCompanionLife(relationshipId, item.id, item.version))
                }
              >
                删除
              </Button>
            </article>
          ))}
      </div>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            saveCompanionLife(relationshipId, {
              id: editing?.id ?? draftId,
              version: editing?.version ?? 0,
              kind,
              label,
              title,
              content,
              occurredOn: date || null,
              personIds,
            }),
          );
        }}
      >
        <fieldset disabled={busy || items === null} className="space-y-2">
          <label className="block">
            记录类型{' '}
            <select
              aria-label="记录类型"
              value={kind}
              disabled={!!editing}
              onChange={(event) => {
                setKind(event.target.value as CompanionLifeKind);
                setPersonIds([]);
                setLabel('');
              }}
            >
              {Object.entries(KINDS)
                .filter(([k]) => k !== 'lifecycle' || kind === 'lifecycle')
                .map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            {kind === 'person' ? '名字' : '标题'}
            <Input
              aria-label="记录名称"
              value={title}
              required
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {kind === 'lifecycle' ? (
            <>
              <label className="block">
                关系阶段{' '}
                <select
                  aria-label="关系阶段"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                >
                  {Object.entries(STAGES).map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs">
                暂停或结束会暂停这段关系的所有定时联系。恢复关系后仍需逐条手动恢复，不会自动开启。
              </p>
            </>
          ) : (
            <label className="block">
              {kind === 'person' ? '与你的关系' : '分类'}
              <Input
                aria-label="关系或分类"
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          )}
          <label className="block">
            {kind === 'person' ? '备注' : '发生日期'}
            {kind !== 'person' && (
              <input
                aria-label="发生日期"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </label>
          <textarea
            aria-label="记录内容"
            value={content}
            maxLength={4000}
            rows={3}
            onChange={(event) => setContent(event.target.value)}
            className="w-full rounded border bg-transparent p-2"
          />
          {(kind === 'event' || kind === 'milestone') && (
            <fieldset className="flex flex-wrap gap-2">
              <legend>相关人物</legend>
              {items
                ?.filter((i) => i.kind === 'person')
                .map((person) => (
                  <label key={person.id}>
                    <input
                      type="checkbox"
                      checked={personIds.includes(person.id)}
                      onChange={(event) =>
                        setPersonIds((ids) =>
                          event.target.checked
                            ? [...ids, person.id]
                            : ids.filter((id) => id !== person.id),
                        )
                      }
                    />
                    {person.title}
                  </label>
                ))}
            </fieldset>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!title.trim()}>
              保存记录
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clear}>
              取消编辑
            </Button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
