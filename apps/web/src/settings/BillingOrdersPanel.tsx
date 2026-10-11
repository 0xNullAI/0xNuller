import { useEffect, useRef, useState } from 'react';
import {
  getBillingCatalog,
  listBillingOrders,
  createBillingOrder,
  cancelBillingOrder,
  requestBillingRefund,
  type BillingCatalog,
  type BillingOrder,
} from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';
export const BILLING_STATUSES: Record<string, string> = {
  awaiting_payment: '待人工核实付款',
  paid: '已到账',
  cancelled: '已取消',
  expired: '已过期',
  refund_requested: '退款申请待人工处理',
  refunded: '已核实退款并扣回Credit',
};
export function BillingOrdersPanel({ accountId }: { accountId: string }) {
  return <Orders key={accountId} />;
}
function Orders() {
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [offer, setOffer] = useState('credit-1000');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [refund, setRefund] = useState<BillingOrder | null>(null);
  const [reason, setReason] = useState('');
  const alive = useRef(false);
  const lock = useRef(false);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([getBillingCatalog(), listBillingOrders()])
      .then(([c, o]) => {
        if (active) {
          setCatalog(c);
          setOrders(o.items);
          setCursor(o.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '订单读取失败');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  async function change(action: () => Promise<unknown>, message: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (alive.current) {
        setNotice(message);
        setRefund(null);
        setReason('');
        setRefresh((x) => x + 1);
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : '处理失败');
        setBusy(false);
      }
    } finally {
      lock.current = false;
    }
  }
  async function create() {
    if (!catalog) return;
    pending.current ??= crypto.randomUUID();
    await change(async () => {
      await createBillingOrder(pending.current!, offer, catalog.priceVersion);
      pending.current = null;
    }, '订单已创建，尚未扣款或增加Credit。请向管理员提供订单编号核实实际付款。');
  }
  async function more() {
    if (!cursor || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await listBillingOrders(cursor);
      if (alive.current) {
        setOrders((old) => [
          ...old,
          ...result.items.filter((i) => !old.some((o) => o.id === i.id)),
        ]);
        setCursor(result.nextCursor);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="充值订单"
      className="space-y-3 border-b border-[var(--surface-border)] pb-3 text-xs"
    >
      <h3 className="text-sm font-medium">充值订单</h3>
      <p>{catalog?.message ?? '正在读取充值方式…'}</p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="订单充值档位"
          value={offer}
          disabled={busy}
          onChange={(e) => {
            setOffer(e.target.value);
            pending.current = null;
          }}
          className="min-w-0 rounded border bg-[var(--bg)] p-2"
        >
          {catalog?.packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.credits} Credit · ¥{(p.amountMinor / 100).toFixed(2)}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={busy || !catalog} onClick={() => void create()}>
          创建待确认订单
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setRefresh((x) => x + 1);
          }}
        >
          刷新订单
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {orders.map((o) => (
          <article key={o.id} className="rounded border border-[var(--surface-border)] p-2">
            <p>
              {o.credits} Credit · ¥{(o.amountMinor / 100).toFixed(2)} ·{' '}
              {BILLING_STATUSES[o.status] ?? o.status}
            </p>
            <p className="break-all text-[var(--text-soft)]">订单：{o.id}</p>
            {o.status === 'awaiting_payment' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void change(() => cancelBillingOrder(o), '订单已取消。')}
              >
                取消订单
              </Button>
            )}
            {o.status === 'paid' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setRefund(o);
                  setReason('');
                }}
              >
                申请退款
              </Button>
            )}
          </article>
        ))}
      </div>
      {cursor && (
        <Button size="sm" disabled={busy} variant="ghost" onClick={() => void more()}>
          更早订单
        </Button>
      )}
      {refund && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void change(
              () => requestBillingRefund(refund, reason),
              '退款申请已记录，仍需人工核实；应用未执行退款。',
            );
          }}
        >
          <p>
            退款仅处理本人充值订单，不是创作者提现。只支持整单；已消费或预留的Credit需要人工核对。
          </p>
          <textarea
            aria-label="退款原因"
            required
            maxLength={500}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded border bg-transparent p-2"
          />
          <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
            提交退款申请
          </Button>
        </form>
      )}
    </section>
  );
}
