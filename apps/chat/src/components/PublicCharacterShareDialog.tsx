import { useEffect, useState } from 'react';
import { Overlay } from '@0xnullai/ui';
import { fetchMarketItems, type MarketItem } from '@0xnullai/market-client';
import { publicCharacterShare } from '../lib/public-character-share';

export function PublicCharacterShareDialog({
  onSend,
  onClose,
}: {
  onSend: (text: string) => boolean | void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MarketItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MarketItem | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setItems(null);
        setSelected(null);
        setError('');
        void fetchMarketItems({ type: 'scenario', q: query, limit: 50, signal: controller.signal })
          .then((result) => {
            if (!controller.signal.aborted) setItems(result);
          })
          .catch(() => {
            if (!controller.signal.aborted) setError('无法读取公开角色，请稍后重试');
          });
      },
      query ? 250 : 0,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-label="分享公开角色"
        className="flex max-h-[80dvh] w-[min(480px,100%)] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5"
      >
        <h2 className="font-semibold">分享公开角色</h2>
        <p className="text-xs text-[var(--text-soft)]">
          仅发送 Market 公开卡片链接。你的个人称呼、关系和记忆不会分享。
        </p>
        <input
          aria-label="搜索公开角色"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
          }}
          className="rounded-lg border border-[var(--surface-border)] bg-[var(--bg)] p-2"
          placeholder="搜索角色或场景"
        />
        {error ? (
          <p role="alert">{error}</p>
        ) : !items ? (
          <p>加载中…</p>
        ) : items.length === 0 ? (
          <p>暂无匹配的公开角色</p>
        ) : (
          items.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={selected?.id === item.id}
              className={`rounded-lg border p-3 text-left ${selected?.id === item.id ? 'border-[var(--accent)]' : 'border-[var(--surface-border)]'}`}
              onClick={() => setSelected(item)}
            >
              <span className="block">{item.name}</span>
              <span className="text-xs text-[var(--text-faint)]">{item.author || '社区角色'}</span>
            </button>
          ))
        )}
        {selected && (
          <pre className="whitespace-pre-wrap rounded-lg bg-[var(--bg-soft)] p-2 text-xs">
            {publicCharacterShare(selected.id, selected.name)}
          </pre>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (selected && onSend(publicCharacterShare(selected.id, selected.name)) !== false)
                onClose();
            }}
            className="rounded-lg bg-[var(--accent)] px-3 py-2 text-[var(--button-text)] disabled:opacity-40"
          >
            发送到当前聊天
          </button>
        </div>
      </div>
    </Overlay>
  );
}
