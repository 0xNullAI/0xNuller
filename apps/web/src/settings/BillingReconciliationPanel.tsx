import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  currentAuthUserId,
  subscribeAuthChanges,
  listTextBillingReviews,
  recordTextBillingReview,
  type TextBillingReview,
  listBillingOrders,
  listBillingReconciliation,
  confirmBillingPayment,
  type BillingOrder,
  type BillingReconciliation,
} from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';
import { VoiceReconciliationPanel } from './VoiceReconciliationPanel';
import { MediaReconciliationPanel } from './MediaReconciliationPanel';
import { AsrReconciliationPanel } from './AsrReconciliationPanel';
import { BILLING_STATUSES } from './BillingOrdersPanel';
export function BillingReconciliationPanel() {
  const account = useSyncExternalStore(subscribeAuthChanges, currentAuthUserId, () => null);
  if (!account) return null;
  return (
    <div key={account}>
      <Reconciliation />
      <TextReconciliation />
      <VoiceReconciliationPanel />
      <MediaReconciliationPanel />
      <AsrReconciliationPanel />
    </div>
  );
}
function Reconciliation() {
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [events, setEvents] = useState<BillingReconciliation[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<BillingOrder | null>(null);
  const [paymentId, setPaymentId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const live = useRef(false);
  const lock = useRef(false);
  const eventId = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([listBillingOrders(undefined, true), listBillingReconciliation()])
      .then(([o, e]) => {
        if (active) {
          setOrders(o.items);
          setCursor(o.nextCursor);
          setEvents(e.events);
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
  }, [refresh]);
  async function save() {
    if (!selected || !confirmed || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    eventId.current ??= crypto.randomUUID();
    try {
      const result = await confirmBillingPayment(
        selected,
        paymentId,
        eventId.current,
        selected.status === 'refund_requested',
      );
      if (live.current) {
        setNotice(
          result.state === 'applied'
            ? '外部付款事实已记录，账本同步完成。'
            : (result.reason ?? '已进入待对账队列，未自动变更余额。'),
        );
        setSelected(null);
        setConfirmed(false);
        eventId.current = null;
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
      const result = await listBillingOrders(cursor, true);
      if (live.current) {
        setOrders((old) => [
          ...old,
          ...result.items.filter((i) => !old.some((o) => o.id === i.id)),
        ]);
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
      aria-label="订单与退款对账"
      className="my-6 space-y-3 rounded border border-[var(--surface-border)] p-3 text-xs"
    >
      <h2 className="text-sm font-semibold">订单与退款对账</h2>
      <p>
        尚未接通在线商户。这里仅记录已核实的外部实际收款／退款，不会发起扣款或转账。不要把待确认订单当成收款凭证。已消费或预留Credit的退款需人工处理差额。
      </p>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setRefresh((x) => x + 1);
        }}
      >
        刷新对账
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {orders.map((o) => (
          <article key={o.id} className="border-b border-[var(--surface-border)] pb-2">
            <p className="break-all">
              {o.id} · 账户 {o.accountId}
            </p>
            <p>
              ¥{(o.amountMinor / 100).toFixed(2)} · {o.credits} Credit ·{' '}
              {BILLING_STATUSES[o.status] ?? o.status}
            </p>
            {['awaiting_payment', 'refund_requested'].includes(o.status) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setSelected(o);
                  setPaymentId('');
                  setConfirmed(false);
                  eventId.current = null;
                }}
              >
                {o.status === 'refund_requested' ? '核实已实际退款' : '核实已实际收款'}
              </Button>
            )}
          </article>
        ))}
      </div>
      {cursor && (
        <Button size="sm" disabled={busy} onClick={() => void more()}>
          更早订单
        </Button>
      )}
      {selected && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="break-all">
            处理 {selected.id} · ¥{(selected.amountMinor / 100).toFixed(2)}
          </p>
          <label className="block">
            原付款流水号
            <input
              aria-label="订单付款流水"
              required
              pattern="[A-Za-z0-9._:-]{8,128}"
              value={paymentId}
              disabled={busy}
              onChange={(e) => {
                setPaymentId(e.target.value);
                eventId.current = null;
              }}
              className="ml-2 max-w-full rounded border bg-transparent p-2"
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              required
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已核对原始支付渠道，实际收款／整单退款金额、币种及收款账户与此订单一致
          </label>
          <Button type="submit" size="sm" disabled={busy || !confirmed}>
            记录事实并同步账本
          </Button>
        </form>
      )}
      <details>
        <summary>最近100条对账事件</summary>
        <ul className="max-h-64 overflow-y-auto">
          {events.map((e) => (
            <li key={`${e.provider}:${e.event_id}`} className="break-all border-b py-2">
              {e.order_id} · {e.kind === 'paid' ? '收款' : '退款'} ·{' '}
              {e.state === 'applied' ? '已入账' : '需人工核对'} · {e.reason ?? e.payment_id}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function TextReconciliation() {
  const [items, setItems] = useState<TextBillingReview[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<TextBillingReview | null>(null);
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
    void listTextBillingReviews()
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
  }, [refresh]);
  async function saveNote() {
    if (!selected || note.trim().length < 3 || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    event.current ??= crypto.randomUUID();
    try {
      await recordTextBillingReview(selected, event.current, note);
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
      const result = await listTextBillingReviews(cursor);
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
      aria-label="文字 Credit 待核对任务"
      className="my-6 space-y-3 rounded border border-[var(--surface-border)] p-3 text-xs"
    >
      <h2 className="text-sm font-semibold">文字 Credit 待核对任务</h2>
      <p>
        显示仍预留、需要人工核对或已有核对记录的任务。确认用量由后台自动重试；未知用量不能补估扣款。备注只保留核对证据，不代表账务问题已解决，也不会扣款、退款或释放预留。请勿填写聊天正文或登录凭据。
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
        刷新文字账务
      </Button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!busy && items.length === 0 && <p>当前没有待核对任务。</p>}
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {items.map((item) => (
          <article key={item.id} className="border-b pb-2">
            <p className="break-all">
              {item.id} · 账户 {item.accountId} · {item.model}
            </p>
            <p>
              任务 {item.state} · 预留状态 {item.status} · 预留 {item.reserved} Credit · 确认费用{' '}
              {item.confirmedCharge ?? '未知'} · 已扣 {item.charged ?? '无'}
            </p>
            <p>
              确认输入 / 输出 token：{item.promptTokens ?? '未知'} /{' '}
              {item.completionTokens ?? '未知'}；重试 {item.attempts} 次
            </p>
            <p>
              原因：{item.reason ?? '等待后台处理'} · 更新{' '}
              {new Date(item.updatedAt).toLocaleString()}
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
          更早文字任务
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
            aria-label="文字账务核对备注"
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
