import { requestProfileView, subscribeAuthChanges } from '@0xnullai/auth';
import { useEffect, useState } from 'react';
import { fetchCreatorFollow, saveCreatorFollow, type CreatorFollowState } from '../api';
export function CreatorFollowAction({ itemId }: { itemId: string }) {
  const [state, setState] = useState<CreatorFollowState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void fetchCreatorFollow(itemId)
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setError('登录后可查看可信作者与关注');
      });
    const stop = subscribeAuthChanges(() => {
      live = false;
      setState(null);
      setError('账户已变化，请重新打开');
    });
    return () => {
      live = false;
      stop();
    };
  }, [itemId]);
  async function toggle() {
    if (!state?.creator || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveCreatorFollow(itemId, state.creator.id, !state.followed, state.accountId);
      setState({ ...state, followed: !state.followed });
    } catch (e) {
      setError(e instanceof Error ? e.message : '关注失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {state?.creator ? (
        <>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => requestProfileView(state.creator!.username)}
          >
            发布账户：{state.creator.displayName} (@{state.creator.username})
          </button>
          {state.creator.id !== state.accountId && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              aria-pressed={state.followed}
              onClick={() => void toggle()}
            >
              {state.followed ? '已关注 · 取消' : '关注作者'}
            </button>
          )}
        </>
      ) : state ? (
        <span>此内容暂无可验证的发布账户；署名不作为关注身份。</span>
      ) : null}
      {error && <span role="status">{error}</span>}
    </div>
  );
}
