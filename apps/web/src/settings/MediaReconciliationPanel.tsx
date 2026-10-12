import { useEffect, useRef, useState } from 'react';
import {
  listMediaBillingReviews,
  recordMediaBillingReview,
  type MediaBillingReview,
} from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';

export function MediaReconciliationPanel() {
  const [items, setItems] = useState<MediaBillingReview[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<MediaBillingReview | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const eventId = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    void listMediaBillingReviews()
      .then((result) => {
        if (!current) return;
        setItems(result.items);
        setCursor(result.nextCursor);
        setError('');
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : '读取媒体账务失败');
      });
    return () => {
      current = false;
    };
  }, [reload]);

  async function loadMore() {
    if (cursor === null || busy) return;
    setBusy(true);
    try {
      const result = await listMediaBillingReviews(cursor);
      setItems((previous) => [
        ...previous,
        ...result.items.filter((item) => !previous.some((old) => old.id === item.id)),
      ]);
      setCursor(result.nextCursor);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取媒体账务失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    if (!selected || note.trim().length < 3 || busy) return;
    setBusy(true);
    eventId.current ??= crypto.randomUUID();
    try {
      await recordMediaBillingReview(selected, eventId.current, note.trim());
      setSelected(null);
      setNote('');
      eventId.current = null;
      setNotice('备注已记录；余额、账务状态和媒体交付均未改变。');
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录备注失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="媒体 Credit 待核对任务"
      className="my-6 space-y-3 rounded border border-[var(--surface-border)] p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">媒体 Credit 待核对任务</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setReload((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      <p>
        查看生成结果、预留与账本证据。备注不可修改，不会补扣、退款或交付媒体；请勿填写聊天正文或凭据。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {items.length === 0 && <p>当前没有待核对任务。</p>}
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {items.map((item) => (
          <article key={item.id} className="space-y-1 border-b pb-2">
            <p className="break-all">
              {item.kind} · {item.jobId} · 账户 {item.accountId}
            </p>
            <p>
              原因 {item.reason} · 任务 {item.jobState} · 预留 {item.reservationStatus ?? '缺失'}
            </p>
            <p>
              原冻结 {item.reservedAtReview} Credit · 当前冻结 {item.reservedNow ?? '缺失'} · 已扣{' '}
              {item.chargedNow ?? '未记录'} · 使用账本 {item.ledgerCount} 笔
            </p>
            <p>
              创建 {new Date(item.createdAt).toLocaleString()} · 备注 {item.notes.length} 条
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(item);
                setNote('');
                eventId.current = null;
                setNotice('');
              }}
            >
              记录备注
            </Button>
          </article>
        ))}
      </div>
      {cursor !== null && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadMore()}>
          加载更多
        </Button>
      )}
      {selected && (
        <div className="space-y-2 rounded border border-[var(--surface-border)] p-2">
          <p className="break-all">核对 {selected.jobId}</p>
          <textarea
            aria-label="媒体核对备注"
            className="w-full rounded border border-[var(--surface-border)] bg-transparent p-2"
            maxLength={1000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              eventId.current = null;
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || note.trim().length < 3}
              onClick={() => void saveNote()}
            >
              保存备注
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                eventId.current = null;
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
