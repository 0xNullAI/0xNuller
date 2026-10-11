import { useEffect, useRef, useState } from 'react';
import {
  listVoiceBillingReviews,
  recordVoiceBillingReview,
  type VoiceBillingReview,
  type VoiceReviewFilter,
} from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';

export function VoiceReconciliationPanel() {
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<VoiceReviewFilter>({});
  const [error, setError] = useState('');
  return (
    <div>
      <form
        aria-label="筛选语音审核"
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const start = from ? new Date(from).getTime() : undefined;
          const end = to ? new Date(to).getTime() : undefined;
          if (
            (start !== undefined && !Number.isFinite(start)) ||
            (end !== undefined && !Number.isFinite(end)) ||
            (start !== undefined && end !== undefined && start > end)
          ) {
            setError('时间范围无效');
            return;
          }
          setError('');
          setFilter({ accountId: accountId.trim() || undefined, from: start, to: end });
        }}
      >
        <label>
          语音账户
          <input
            aria-label="语音审核账户"
            maxLength={128}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          />
        </label>
        <label>
          开始时间
          <input
            aria-label="语音审核开始时间"
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            aria-label="语音审核结束时间"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <Button type="submit" size="sm">
          筛选语音记录
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <VoiceReviewList key={JSON.stringify(filter)} filter={filter} />
    </div>
  );
}
function VoiceReviewList({ filter }: { filter: VoiceReviewFilter }) {
  const [items, setItems] = useState<VoiceBillingReview[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<VoiceBillingReview | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const live = useRef(false);
  const lock = useRef(false);
  const event = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void listVoiceBillingReviews(filter)
      .then((result) => {
        if (active) {
          setItems(result.items);
          setCursor(result.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '读取失败');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [refresh, filter]);
  async function saveNote() {
    if (!selected || note.trim().length < 3 || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    event.current ??= crypto.randomUUID();
    try {
      await recordVoiceBillingReview(selected, event.current, note);
      if (live.current) {
        setNotice('核对备注已记录，未改变余额或账务状态。');
        setSelected(null);
        setNote('');
        event.current = null;
        setRefresh((x) => x + 1);
      }
    } catch (e) {
      if (live.current) {
        setError(e instanceof Error ? e.message : '记录失败');
        setBusy(false);
      }
    } finally {
      lock.current = false;
    }
  }
  async function more() {
    if (!cursor || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await listVoiceBillingReviews(filter, cursor);
      if (live.current) {
        setItems((old) => [...old, ...result.items.filter((i) => !old.some((o) => o.id === i.id))]);
        setCursor(result.nextCursor);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="语音 Credit 待核对任务"
      className="my-6 space-y-3 rounded border border-[var(--surface-border)] p-3 text-xs"
    >
      <h2 className="text-sm font-semibold">语音 Credit 待核对任务</h2>
      <p>
        只读展示冻结过期的语音证据。请求报价不是实际扣款；备注不可修改，不会扣费、改账或标记完成。请勿填写聊天正文或凭据。
      </p>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          setSelected(null);
          event.current = null;
          setRefresh((x) => x + 1);
        }}
      >
        刷新语音账务
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!busy && items.length === 0 && <p>当前没有待核对任务。</p>}
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {items.map((item) => (
          <article key={item.id} className="border-b pb-2">
            <p className="break-all">
              {item.id} · 账户 {item.accountId}
            </p>
            <p>
              预留状态 {item.status} · 原预留 {item.reserved} Credit · 实扣{' '}
              {item.charged ?? '未扣费'}
            </p>
            <p>
              确认时长 {item.durationMs} ms · 请求 {item.requestedAction} · 请求报价{' '}
              {item.requestedCredits} Credit（非扣款）
            </p>
            <p>
              价格版本 {item.priceVersion} · 冻结时间{' '}
              {new Date(item.holdUpdatedAt).toLocaleString()}
            </p>
            <p>
              原因：{item.reason === 'reservation_expired' ? '冻结过期，待人工核对' : item.reason} ·
              记录 {new Date(item.createdAt).toLocaleString()}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(item);
                setNote('');
                event.current = null;
                setNotice('');
              }}
            >
              记录核对备注：{item.id}
            </Button>
            {item.notes.length > 0 && (
              <details>
                <summary>最近核对记录（最多5条）</summary>
                {item.notes.map((n) => (
                  <p key={n.eventId} className="whitespace-pre-wrap break-words">
                    {n.operatorId} · {new Date(n.createdAt).toLocaleString()}：{n.note}
                  </p>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>
      {cursor && (
        <Button size="sm" disabled={busy} onClick={() => void more()}>
          更早语音记录
        </Button>
      )}
      {selected && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveNote();
          }}
          className="space-y-2"
        >
          <p className="break-all">为 {selected.id} 添加不可修改的核对备注</p>
          <textarea
            aria-label="语音账务核对备注"
            required
            minLength={3}
            maxLength={1000}
            value={note}
            disabled={busy}
            onChange={(e) => {
              setNote(e.target.value);
              event.current = null;
            }}
            className="w-full rounded border bg-transparent p-2"
          />
          <Button type="submit" size="sm" disabled={busy || note.trim().length < 3}>
            保存核对备注（不改账）
          </Button>
        </form>
      )}
    </section>
  );
}
