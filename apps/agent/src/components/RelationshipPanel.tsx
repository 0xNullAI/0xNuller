import { useEffect, useRef, useState } from 'react';
import {
  deleteCharacterRelationship,
  ensureCharacterRelationship,
  listCharacterRelationships,
  saveCharacterRelationship,
  type CharacterRelationship,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';

export interface RelationshipPanelProps {
  characterId: string;
  characterName: string;
  /** Parent keys this panel by account id; notifications contain only the current private relation. */
  onChange?: (relationship: CharacterRelationship | null) => void;
}

/** No scene writes: author updates and personal relationship names remain independent. */
export function RelationshipPanel(props: RelationshipPanelProps) {
  return <RelationshipEditor key={props.characterId} {...props} />;
}

function RelationshipEditor({ characterId, characterName, onChange }: RelationshipPanelProps) {
  const [relationship, setRelationship] = useState<CharacterRelationship | null>(null);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const [aiNickname, setAiNickname] = useState('');
  const [userPreferredName, setUserPreferredName] = useState('');
  const [relationshipType, setRelationshipType] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  const notify = useRef(onChange);
  useEffect(() => {
    notify.current = onChange;
  }, [onChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function apply(item: CharacterRelationship | null) {
    setRelationship(item);
    setAiNickname(item?.aiNickname ?? '');
    setUserPreferredName(item?.userPreferredName ?? '');
    setRelationshipType(item?.relationshipType ?? '');
    setNotes(item?.notes ?? '');
  }
  useEffect(() => {
    let active = true;
    void listCharacterRelationships(characterId)
      .then(async ({ items }) => {
        if (!active) return;
        let item = items[0] ?? null;
        if (!item) {
          try {
            item = (await ensureCharacterRelationship(characterId)).item;
          } catch {
            // Explicitly deleted identities can only be recreated by the Save action.
          }
        }
        if (!active) return;
        apply(item);
        setLoaded(true);
        notify.current?.(item);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '关系读取失败');
      });
    return () => {
      active = false;
    };
  }, [characterId, reload]);

  async function save() {
    if (busy || !loaded) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { item } = await saveCharacterRelationship({
        id: relationship?.id ?? draftId,
        version: relationship?.version ?? 0,
        characterId,
        aiNickname,
        userPreferredName,
        relationshipType,
        notes,
      });
      if (!alive.current) return;
      apply(item);
      notify.current?.(item);
      setNotice('已保存专属关系');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove() {
    if (busy || !relationship) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteCharacterRelationship(relationship.id, relationship.version);
      if (!alive.current) return;
      apply(null);
      setDraftId(crypto.randomUUID());
      notify.current?.(null);
      setNotice('已删除专属关系；角色原设定保持不变');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="专属关系"
      className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3"
    >
      <p className="text-sm font-medium">与{characterName}的专属关系</p>
      <p className="text-xs text-[var(--text-soft)]">
        仅自己可见。称呼与共同约定随账号保存，不会发布到角色卡或群聊。
      </p>
      {error && (
        <div role="alert" className="text-sm text-[var(--danger)]">
          {error}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setLoaded(false);
              setError('');
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
      {!loaded ? (
        <p className="text-xs">{error ? '暂时无法读取关系' : '正在读取关系…'}</p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block text-sm">
            给 AI 的名字
            <Input
              aria-label="给 AI 的名字"
              value={aiNickname}
              maxLength={80}
              disabled={busy}
              placeholder={characterName}
              onChange={(event) => setAiNickname(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            AI 怎么称呼你
            <Input
              aria-label="AI 怎么称呼你"
              value={userPreferredName}
              maxLength={80}
              disabled={busy}
              placeholder="留空时沿用默认称呼"
              onChange={(event) => setUserPreferredName(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            我们的关系
            <Input
              aria-label="我们的关系"
              value={relationshipType}
              maxLength={80}
              disabled={busy}
              placeholder="例如：朋友、创作伙伴"
              onChange={(event) => setRelationshipType(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            共同约定
            <textarea
              aria-label="共同约定"
              value={notes}
              maxLength={4000}
              disabled={busy}
              rows={3}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-transparent p-2 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? '处理中…' : '保存关系'}
            </Button>
            {relationship && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void remove()}
              >
                删除关系
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
