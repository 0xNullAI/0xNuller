import { useEffect, useRef, useState } from 'react';
import { fetchFollowedCreators, saveCreatorFollow } from '../api';
import { requestProfileView, subscribeAuthChanges } from '@0xnullai/auth';
export function FollowedCreators({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<Awaited<ReturnType<typeof fetchFollowedCreators>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    const requestGeneration = generation;
    const load = (clear = false) => {
      const current = ++requestGeneration.current;
      if (clear) {
        setState(null);
        setError('');
        setBusy(false);
      }
      void fetchFollowedCreators()
        .then((s) => {
          if (live && current === requestGeneration.current) setState(s);
        })
        .catch(() => {
          if (live && current === requestGeneration.current) setError('无法加载关注列表');
        });
    };
    load();
    const stop = subscribeAuthChanges(() => {
      load(true);
    });
    return () => {
      live = false;
      requestGeneration.current++;
      stop();
    };
  }, []);
  async function remove(id: string) {
    if (!state || busy) return;
    const current = generation.current;
    setBusy(true);
    try {
      await saveCreatorFollow('', id, false, state.accountId);
      if (current === generation.current) {
        setState({ ...state, creators: state.creators.filter((c) => c.id !== id) });
        onChanged();
      }
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : '取消失败');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <details className="my-2 rounded-lg border border-[var(--surface-border)] p-3">
      <summary>管理已关注作者 {state ? `(${state.creators.length})` : ''}</summary>
      {error && <p role="alert">{error}</p>}
      <div className="max-h-48 overflow-y-auto">
        {state?.creators.map((creator) => (
          <div key={creator.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            {creator.profile ? (
              <button
                type="button"
                className="text-left underline-offset-2 hover:underline"
                onClick={() => requestProfileView(creator.profile!.username)}
              >
                {creator.profile.displayName} (@{creator.profile.username})
              </button>
            ) : (
              <span>暂未取得公开资料 · {creator.id.slice(-6)}</span>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void remove(creator.id)}
            >
              取消关注
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
