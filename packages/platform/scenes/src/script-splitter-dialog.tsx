import { useEffect, useId, useRef, useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { currentAuthUserId } from '@0xnullai/auth';
import { Button, Checkbox, Overlay } from '@0xnullai/ui';
import { newSceneId, updateScenes, type SavedScene } from './index.js';
import {
  buildCharacterMessages,
  buildOutlineMessages,
  buildSplitCards,
  estimateCharacterCredits,
  estimateOutlineCredits,
  parseGeneratedCharacter,
  parseOutline,
  type GeneratedCharacter,
  type ScriptOutline,
  type ScriptSource,
} from './script-splitter.js';
import {
  loadSplitCatalog,
  requestSplitCompletion,
  type SplitCatalog,
} from './script-splitter-request.js';

export type { ScriptSource } from './script-splitter.js';

export interface ScriptSplitterDialogProps {
  source: ScriptSource;
  onClose: () => void;
  /** Open a chat with a newly saved card; the host decides how. */
  onStartChat?: (card: SavedScene) => void;
  onSaved?: (cards: SavedScene[]) => void;
}

type Step = 'confirm' | 'outlining' | 'pick' | 'generating' | 'interrupted' | 'done';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 拆分角色 / 提取角色. Every paid call is confirmed with an estimate first, can be stopped, and
 * nothing reaches the library until the user's chosen cards are all valid (or they choose to
 * keep the ones already finished).
 */
export function ScriptSplitterDialog({
  source,
  onClose,
  onStartChat,
  onSaved,
}: ScriptSplitterDialogProps) {
  const titleId = useId();
  const [step, setStep] = useState<Step>('confirm');
  const [catalog, setCatalog] = useState<SplitCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [outline, setOutline] = useState<ScriptOutline | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeScene, setIncludeScene] = useState(true);
  const [generated, setGenerated] = useState<GeneratedCharacter[]>([]);
  const [current, setCurrent] = useState('');
  const [saved, setSaved] = useState<SavedScene[]>([]);
  const controller = useRef<AbortController | null>(null);
  const account = useRef(currentAuthUserId());
  const signedIn = Boolean(account.current);

  useEffect(() => {
    if (!signedIn) return;
    const load = new AbortController();
    loadSplitCatalog(load.signal)
      .then(setCatalog)
      .catch((reason: unknown) => {
        if (!load.signal.aborted) setCatalogError(errorText(reason, '价格暂不可用'));
      });
    return () => load.abort();
  }, [signedIn]);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // A paid run belongs to the account that started it; switching accounts ends it unsaved.
  // Registered once, so a host re-render never aborts a request in flight.
  useEffect(() => {
    const onAuth = () => {
      if (currentAuthUserId() === account.current) return;
      controller.current?.abort();
      closeRef.current();
    };
    window.addEventListener('0xnullai:auth-changed', onAuth);
    return () => {
      window.removeEventListener('0xnullai:auth-changed', onAuth);
      controller.current?.abort();
    };
  }, []);

  const busy = step === 'outlining' || step === 'generating';
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  const stop = () => controller.current?.abort();

  function begin(): AbortController {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setError('');
    return next;
  }

  async function runOutline() {
    const run = begin();
    setStep('outlining');
    try {
      const text = await requestSplitCompletion(buildOutlineMessages(source), run.signal);
      const next = parseOutline(text);
      if (run.signal.aborted) return;
      setOutline(next);
      const main = next.characters.filter((member) => member.isMain).map((member) => member.name);
      setSelected(main.length ? main : next.characters.slice(0, 1).map((member) => member.name));
      setGenerated([]);
      setStep('pick');
    } catch (reason) {
      setError(run.signal.aborted ? '已停止' : errorText(reason, '整理失败，请重试'));
      setStep('confirm');
    }
  }

  function save(characters: GeneratedCharacter[]) {
    if (!outline) return;
    if (currentAuthUserId() !== account.current) {
      setError('账号已切换，未保存');
      return;
    }
    try {
      const cards = buildSplitCards(source, outline, characters, {
        includeScene,
        newId: newSceneId,
      });
      if (!cards.length) return;
      // New private cards go first; nothing here selects or publishes them.
      updateScenes((library) => ({ ...library, scenes: [...cards, ...library.scenes] }));
      setSaved(cards);
      setStep('done');
      onSaved?.(cards);
    } catch (reason) {
      setError(errorText(reason, '保存失败，请重试'));
      setStep('interrupted');
    }
  }

  async function runCharacters(done: GeneratedCharacter[]) {
    if (!outline) return;
    const run = begin();
    setStep('generating');
    const results = [...done];
    for (const name of selected) {
      if (results.some((character) => character.name === name)) continue;
      setCurrent(name);
      try {
        const text = await requestSplitCompletion(
          buildCharacterMessages(source, outline, name),
          run.signal,
        );
        if (run.signal.aborted) throw new Error('已停止');
        // Keep the outline's name so a retry or the checklist still matches this character.
        results.push({ ...parseGeneratedCharacter(text, name), name });
        setGenerated([...results]);
      } catch (reason) {
        setGenerated([...results]);
        setError(run.signal.aborted ? '已停止' : errorText(reason, '整理失败，请重试'));
        setStep('interrupted');
        return;
      }
    }
    save(results);
  }

  const outlineEstimate = catalog ? estimateOutlineCredits(catalog, source) : null;
  const remaining = selected.filter((name) => !generated.some((entry) => entry.name === name));
  const characterEstimate =
    catalog && outline ? estimateCharacterCredits(catalog, source, outline, remaining) : null;
  const estimateLine = (credits: number | null) =>
    credits === null
      ? catalogError || '正在计算费用…'
      : `预计约 ${credits} Credit（按实际用量扣费）${catalog?.available !== undefined ? ` · 余额 ${Math.floor(catalog.available)}` : ''}`;
  const toggle = (name: string, checked: boolean) =>
    setSelected((previous) =>
      checked
        ? outline!.characters.map((m) => m.name).filter((n) => n === name || previous.includes(n))
        : previous.filter((entry) => entry !== name),
    );

  return (
    <Overlay
      level="stacked"
      onDismiss={busy ? undefined : close}
      className="!items-end !p-0 backdrop-blur-[2px] sm:!items-center sm:!p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[calc(var(--android-viewport-height,100dvh)-env(safe-area-inset-top)-0.5rem)] w-full flex-col overflow-hidden rounded-t-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-xl sm:max-h-[min(720px,calc(100dvh-2rem))] sm:w-[min(560px,calc(100vw-2rem))] sm:rounded-[var(--radius-lg)]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--surface-border)] px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-[var(--text)]">
              {source.derivedFrom ? '提取角色' : '拆分角色'}
            </h2>
            <p className="mt-0.5 truncate text-sm text-[var(--text-soft)]">
              《{source.name}》· 由猫愿模型整理，存为私有卡
            </p>
          </div>
          {!busy && (
            <button
              type="button"
              onClick={close}
              aria-label="关闭"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm sm:px-5 sm:pb-5">
          {error && (
            <p role="alert" className="text-[var(--danger)]">
              {error}
            </p>
          )}

          {!signedIn ? (
            <p>请先登录后使用。这是猫愿模型功能，按 Credit 计费。</p>
          ) : step === 'confirm' ? (
            <>
              <p className="text-[var(--text-soft)]">
                先读完全文（{source.prompt.length.toLocaleString()}{' '}
                字），列出场景和主要角色，再由你挑选要生成的角色。
                {source.derivedFrom ? '结果只保存在你的私有库，不会公开。' : ''}
              </p>
              <p role="status">{estimateLine(outlineEstimate)}</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={!catalog} onClick={() => void runOutline()}>
                  {error ? '重试' : '开始整理'}
                </Button>
                <Button size="sm" variant="ghost" onClick={close}>
                  取消
                </Button>
              </div>
            </>
          ) : step === 'outlining' ? (
            <>
              <p role="status">正在阅读剧本…</p>
              <Button size="sm" variant="ghost" onClick={stop}>
                停止
              </Button>
            </>
          ) : step === 'pick' || step === 'interrupted' || step === 'generating' ? (
            outline && (
              <>
                <p className="text-[var(--text-soft)]">选择要生成的角色：</p>
                <ul className="space-y-1.5">
                  {outline.characters.map((member) => {
                    const done = generated.some((entry) => entry.name === member.name);
                    return (
                      <li key={member.name}>
                        <label className="flex items-start gap-2">
                          <Checkbox
                            className="mt-0.5"
                            aria-label={member.name}
                            checked={selected.includes(member.name)}
                            disabled={step !== 'pick' || done}
                            onCheckedChange={(checked) => toggle(member.name, checked === true)}
                          />
                          <span className="min-w-0">
                            <span className="font-medium">{member.name}</span>
                            {done ? ' ✓' : ''}
                            {member.oneLine && (
                              <span className="block text-[12px] text-[var(--text-faint)]">
                                {member.oneLine}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <label className="flex items-center gap-2 border-t border-[var(--surface-border)] pt-3">
                  <Checkbox
                    aria-label="同时保存场景"
                    checked={includeScene}
                    disabled={step !== 'pick'}
                    onCheckedChange={(checked) => setIncludeScene(checked === true)}
                  />
                  <span>
                    同时保存场景
                    <span className="text-[var(--text-faint)]">《{outline.scene.name}》</span>
                  </span>
                </label>
                {step === 'generating' ? (
                  <>
                    <p role="status">
                      正在整理「{current}」（{generated.length + 1}/{selected.length}）…
                    </p>
                    <Button size="sm" variant="ghost" onClick={stop}>
                      停止
                    </Button>
                  </>
                ) : (
                  <>
                    {remaining.length > 0 && <p role="status">{estimateLine(characterEstimate)}</p>}
                    <div className="flex flex-wrap gap-2">
                      {step === 'pick' ? (
                        <Button
                          size="sm"
                          disabled={!catalog || (!selected.length && !includeScene)}
                          onClick={() => (selected.length ? void runCharacters([]) : save([]))}
                        >
                          {selected.length ? `生成 ${selected.length} 个角色` : '只保存场景'}
                        </Button>
                      ) : (
                        <>
                          <Button size="sm" onClick={() => void runCharacters(generated)}>
                            继续
                          </Button>
                          {generated.length > 0 && (
                            <Button size="sm" variant="secondary" onClick={() => save(generated)}>
                              只保存已完成的 {generated.length} 个
                            </Button>
                          )}
                        </>
                      )}
                      <Button size="sm" variant="ghost" onClick={close}>
                        取消
                      </Button>
                    </div>
                  </>
                )}
              </>
            )
          ) : (
            <>
              <p role="status">已保存到「角色与场景」，仅你可见：</p>
              <ul className="space-y-1.5">
                {saved.map((card) => (
                  <li key={card.id} className="flex items-center gap-2">
                    <span className="shrink-0">{card.icon}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {card.name}
                      <span className="text-[12px] text-[var(--text-faint)]">
                        {' · '}
                        {card.kind === 'scene' ? '场景' : '角色'}
                      </span>
                    </span>
                    {onStartChat && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`和 ${card.name} 聊天`}
                        onClick={() => {
                          onStartChat(card);
                          onClose();
                        }}
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        聊天
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" onClick={onClose}>
                完成
              </Button>
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}
