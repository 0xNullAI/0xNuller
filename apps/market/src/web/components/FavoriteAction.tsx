import { subscribeAuthChanges } from '@0xnullai/auth';
import { useEffect, useState } from 'react';
import { fetchFavorite, saveFavorite, type FavoriteState } from '../api';

export function FavoriteAction({ itemId }: { itemId: string }) {
  const [state, setState] = useState<FavoriteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void fetchFavorite(itemId)
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setError('登录后可收藏，或稍后重试');
      });
    const unsubscribe = subscribeAuthChanges(() => {
      live = false;
      setState(null);
      setError('账户已变化，请重新打开');
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [itemId]);
  const toggle = async () => {
    if (!state || busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await saveFavorite(itemId, !state.favorited, state.accountId));
    } catch (error) {
      setError(error instanceof Error ? error.message : '收藏失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn"
        disabled={!state || busy}
        aria-pressed={state?.favorited ?? false}
        onClick={() => void toggle()}
      >
        {state?.favorited ? '已收藏 · 取消' : '收藏角色 / 内容'}
      </button>
      {error && (
        <span role="status" className="text-xs">
          {error}
        </span>
      )}
    </div>
  );
}
