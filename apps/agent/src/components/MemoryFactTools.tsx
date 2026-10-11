import { useEffect, useState } from 'react';
import {
  deleteMemoryPerson,
  correctMemoryFact,
  linkMemoryPerson,
  listMemoryPeople,
  listPersonalMemories,
  saveMemoryPerson,
  supersedeMemoryFact,
  unlinkMemoryPerson,
  type MemoryPerson,
  type PersonalMemory,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';
import {
  notifyRelationshipMemoryChanged,
  subscribeRelationshipMemoryChanged,
} from './relationship-memory-events';

interface Props {
  relationshipId: string;
}

/** Optional tools for explicit person disambiguation and fact correction in one private relationship. */
export function MemoryFactTools({ relationshipId }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">人物别名与事实纠错</summary>
      {open && <Editor key={relationshipId} relationshipId={relationshipId} />}
    </details>
  );
}

function Editor({ relationshipId }: Props) {
  const [people, setPeople] = useState<MemoryPerson[] | null>(null);
  const [memories, setMemories] = useState<PersonalMemory[] | null>(null);
  const [asOf, setAsOf] = useState(0);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<MemoryPerson | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [oldId, setOldId] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [correctionTitle, setCorrectionTitle] = useState('');
  const [correctionContent, setCorrectionContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([listMemoryPeople(relationshipId), listPersonalMemories(relationshipId)])
      .then(([persons, facts]) => {
        if (!active) return;
        setPeople(persons.items);
        setMemories(facts.items);
        setAsOf(Date.now());
        setError('');
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '读取人物与记忆失败');
      });
    return () => {
      active = false;
    };
  }, [relationshipId, reload]);
  useEffect(
    () => subscribeRelationshipMemoryChanged(relationshipId, () => setReload((n) => n + 1)),
    [relationshipId],
  );

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请刷新后重试');
    } finally {
      setBusy(false);
    }
  }
  function clearForm() {
    setEditing(null);
    setDraftId(crypto.randomUUID());
    setName('');
    setAliases('');
  }
  const activeMemories = (memories ?? []).filter(
    (memory) =>
      memory.state === 'active' &&
      memory.effectiveState !== 'superseded' &&
      !memory.supersededById &&
      (!memory.expiresAt || memory.expiresAt > asOf),
  );
  const selectedOld = activeMemories.find((memory) => memory.id === oldId);
  const selectedReplacement = activeMemories.find((memory) => memory.id === replacementId);

  return (
    <div className="mt-3 space-y-4 text-sm">
      <p className="text-xs text-[var(--text-soft)]">
        这些别名只用于这段关系内已授权记忆的检索，不读取通讯录或朋友圈；同名人物可分别保存。纠错会让旧事实退出后续回答，并保留修订记录。
      </p>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}{' '}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReload((n) => n + 1)}>
            重新读取
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {people === null || memories === null ? (
        <p className="text-xs">{error ? '暂时无法读取' : '正在读取…'}</p>
      ) : (
        <>
          <div className="space-y-2">
            <h4 className="font-medium">人物与别名</h4>
            {people.length === 0 && (
              <p className="text-xs text-[var(--text-soft)]">尚未建立人物索引。</p>
            )}
            {people.map((person) => (
              <div
                key={person.id}
                className="flex flex-wrap items-center gap-2 rounded border border-[var(--surface-border)] p-2"
              >
                <span className="min-w-0 flex-1 break-words">
                  {person.displayName}
                  {person.aliases.length ? ` · ${person.aliases.join('、')}` : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`编辑人物 ${person.displayName}`}
                  onClick={() => {
                    setEditing(person);
                    setName(person.displayName);
                    setAliases(person.aliases.join('、'));
                  }}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`删除人物 ${person.displayName}`}
                  onClick={() => {
                    if (!window.confirm('删除此人物别名，并解除它与记忆的关联？记忆正文不会删除。'))
                      return;
                    void run(async () => {
                      await deleteMemoryPerson(person.id, person.version);
                      setPeople((items) => items?.filter((item) => item.id !== person.id) ?? []);
                      setMemories(null);
                      setReload((n) => n + 1);
                      notifyRelationshipMemoryChanged(relationshipId);
                      clearForm();
                      setNotice('人物别名已删除；关联记忆仍保留');
                    });
                  }}
                >
                  删除
                </Button>
              </div>
            ))}
            <form
              className="space-y-2 rounded border border-[var(--surface-border)] p-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const saved = await saveMemoryPerson({
                    id: editing?.id ?? draftId,
                    version: editing?.version ?? 0,
                    relationshipId,
                    displayName: name.trim(),
                    aliases: aliases
                      .split(/[,，、\n]+/u)
                      .map((alias) => alias.trim())
                      .filter(Boolean),
                  });
                  setPeople((items) => [
                    saved.item,
                    ...(items ?? []).filter((item) => item.id !== saved.item.id),
                  ]);
                  clearForm();
                  setNotice('人物别名已保存，仅用于本关系的记忆检索');
                });
              }}
            >
              <p className="font-medium">{editing ? '编辑人物别名' : '添加人物别名'}</p>
              <Input
                aria-label="人物名称"
                value={name}
                maxLength={60}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：小林"
              />
              <Input
                aria-label="人物别名"
                value={aliases}
                disabled={busy}
                onChange={(event) => setAliases(event.target.value)}
                placeholder="别名用逗号分隔，例如：林然"
              />
              <div className="flex gap-2">
                <Button size="sm" type="submit" disabled={busy || name.trim().length < 2}>
                  保存人物
                </Button>
                {editing && (
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={clearForm}
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </form>
          </div>
          <div className="space-y-2">
            <h4 className="font-medium">关联已确认记忆</h4>
            <p className="text-xs text-[var(--text-soft)]">
              先在上方关系记忆中保存事实，再选择它说的是谁。可随时解除关联；不会改变记忆正文。
            </p>
            {activeMemories.length === 0 && <p className="text-xs">没有可关联的已确认记忆。</p>}
            {activeMemories.map((memory) => (
              <label key={memory.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-40 flex-1 break-words">{memory.title}</span>
                <select
                  aria-label={`关联人物 ${memory.title}`}
                  value={memory.personId ?? ''}
                  disabled={busy || (!memory.personId && people.length === 0)}
                  onChange={(event) => {
                    const person = people.find((item) => item.id === event.target.value);
                    void run(async () => {
                      const saved = person
                        ? await linkMemoryPerson(person, memory)
                        : await unlinkMemoryPerson(memory);
                      setMemories(
                        (items) =>
                          items?.map((item) => (item.id === memory.id ? saved.item : item)) ?? [],
                      );
                      notifyRelationshipMemoryChanged(relationshipId);
                      setNotice(person ? '已关联人物，别名可帮助检索此事实' : '已解除人物关联');
                    });
                  }}
                >
                  <option value="">未关联</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.displayName} · {person.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="space-y-2 border-t border-[var(--surface-border)] pt-3">
            <h4 className="font-medium">更正旧事实</h4>
            <p className="text-xs text-[var(--text-soft)]">
              选择旧事实并写下正确内容；保存后旧内容退出后续 AI 上下文，关系和人物关联会保留。
            </p>
            <select
              aria-label="旧事实"
              value={oldId}
              disabled={busy}
              onChange={(event) => {
                const memory = activeMemories.find((item) => item.id === event.target.value);
                setOldId(event.target.value);
                setCorrectionTitle(memory?.title ?? '');
                setCorrectionContent(memory?.content ?? '');
              }}
            >
              <option value="">选择旧事实</option>
              {activeMemories.map((memory) => (
                <option key={memory.id} value={memory.id}>
                  {memory.title} · {memory.content.slice(0, 60)}
                </option>
              ))}
            </select>
            {selectedOld && (
              <div className="space-y-2">
                <Input
                  aria-label="更正标题"
                  value={correctionTitle}
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => setCorrectionTitle(event.target.value)}
                />
                <textarea
                  aria-label="正确内容"
                  value={correctionContent}
                  maxLength={4000}
                  disabled={busy}
                  onChange={(event) => setCorrectionContent(event.target.value)}
                  className="w-full rounded border border-[var(--surface-border)] bg-[var(--surface)] p-2 text-sm"
                  rows={3}
                />
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    !correctionTitle.trim() ||
                    !correctionContent.trim() ||
                    (correctionTitle.trim() === selectedOld.title &&
                      correctionContent.trim() === selectedOld.content)
                  }
                  onClick={() =>
                    void run(async () => {
                      const result = await correctMemoryFact(selectedOld, {
                        kind: selectedOld.kind,
                        title: correctionTitle.trim(),
                        content: correctionContent.trim(),
                      });
                      setMemories((items) => [
                        result.item,
                        ...(items ?? []).filter((item) => item.id !== selectedOld.id),
                      ]);
                      setOldId('');
                      setReplacementId('');
                      setCorrectionTitle('');
                      setCorrectionContent('');
                      notifyRelationshipMemoryChanged(relationshipId);
                      setNotice('旧事实已停用，正确内容已保存');
                    })
                  }
                >
                  确认更正
                </Button>
              </div>
            )}
            <details className="space-y-2">
              <summary className="cursor-pointer text-xs text-[var(--text-soft)]">
                关联已经保存的新事实
              </summary>
              <p className="text-xs text-[var(--text-soft)]">
                如果正确事实已另行保存，可在这里把旧事实替换为它。两条必须属于这段关系。
              </p>
              <select
                aria-label="正确的新事实"
                value={replacementId}
                disabled={busy}
                onChange={(event) => setReplacementId(event.target.value)}
              >
                <option value="">选择新事实</option>
                {activeMemories.map((memory) => (
                  <option key={memory.id} value={memory.id}>
                    {memory.title} · {memory.content.slice(0, 60)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || !selectedOld || !selectedReplacement || oldId === replacementId}
                onClick={() =>
                  void run(async () => {
                    const result = await supersedeMemoryFact(selectedOld!, selectedReplacement!);
                    setMemories(
                      (items) =>
                        items?.map((item) => (item.id === result.item.id ? result.item : item)) ??
                        [],
                    );
                    notifyRelationshipMemoryChanged(relationshipId);
                    setOldId('');
                    setReplacementId('');
                    setNotice('旧事实已退出后续 AI 回答；新事实仍可编辑或删除');
                  })
                }
              >
                确认替换旧事实
              </Button>
            </details>
          </div>
        </>
      )}
    </div>
  );
}
