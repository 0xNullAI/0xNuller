import { useEffect, useState, type JSX } from 'react';
import type { MarketItem } from '../../shared/schema';
import {
  deleteDiscoveryFeedback,
  listDiscoveryFeedback,
  saveDiscoveryFeedback,
  type DiscoveryFeedback,
  type DiscoveryFeedbackReason,
} from '../api';

export function DiscoveryFeedbackAction({
  item,
  onSaved,
}: {
  item: MarketItem;
  onSaved: () => void;
}): JSX.Element {
  const [reason, setReason] = useState<DiscoveryFeedbackReason>('not_interested');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await saveDiscoveryFeedback(
        item.id,
        reason,
        reason === 'hide_creator' ? item.verifiedCreator?.id : undefined,
      );
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '偏好保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-3 text-xs">
      <label>
        推荐反馈{' '}
        <select
          aria-label={`对${item.name}的推荐反馈`}
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value as DiscoveryFeedbackReason)}
        >
          <option value="not_interested">不感兴趣</option>
          <option value="too_similar">少看相似标签</option>
          {item.verifiedCreator && <option value="hide_creator">少看这位作者</option>}
        </select>
      </label>
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
        {busy ? '保存中…' : '应用偏好'}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function DiscoveryFeedbackManager({
  revision,
  onRemoved,
}: {
  revision: number;
  onRemoved: () => void;
}): JSX.Element {
  const [items, setItems] = useState<DiscoveryFeedback[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void listDiscoveryFeedback()
      .then((result) => {
        if (live) setItems(result);
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : '偏好读取失败');
      });
    return () => {
      live = false;
    };
  }, [revision]);
  const remove = async (entry: DiscoveryFeedback) => {
    setError('');
    try {
      await deleteDiscoveryFeedback(entry.kind, entry.targetId);
      setItems((current) =>
        current.filter((item) => item.kind !== entry.kind || item.targetId !== entry.targetId),
      );
      onRemoved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '偏好移除失败');
    }
  };
  return (
    <details className="text-sm">
      <summary>管理推荐偏好 {items.length ? `(${items.length})` : ''}</summary>
      {error && <p role="alert">{error}</p>}
      {!items.length && <p>尚未设置不感兴趣的角色或作者。</p>}
      {items.map((entry) => (
        <div
          key={`${entry.kind}:${entry.targetId}`}
          className="flex items-center justify-between gap-2 py-1"
        >
          <span>
            {entry.reason === 'hide_creator'
              ? `少看〈${entry.sourceItemName ?? '已移除角色'}〉的发布作者`
              : `${entry.reason === 'too_similar' ? '少看相似标签' : '不感兴趣'}：${entry.sourceItemName ?? '已移除角色'}`}
          </span>
          <button type="button" className="btn" onClick={() => void remove(entry)}>
            撤销
          </button>
        </div>
      ))}
    </details>
  );
}
