import { useEffect, useState } from 'react';
import { listAsrBillingReviews, type AsrBillingReview } from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';

export function AsrReconciliationPanel() {
  const [items, setItems] = useState<AsrBillingReview[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void listAsrBillingReviews()
      .then((page) => {
        if (active) {
          setItems(page.items);
          setCursor(page.nextCursor);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '读取识别账务失败');
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  async function more() {
    if (cursor === null) return;
    try {
      const page = await listAsrBillingReviews(cursor);
      setItems((old) => [...old, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取识别账务失败');
    }
  }
  return (
    <section
      aria-label="语音转写 Credit 待核对任务"
      className="my-6 space-y-3 rounded border border-[var(--surface-border)] p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">语音转写 Credit 待核对任务</h2>
        <Button size="sm" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
          刷新
        </Button>
      </div>
      <p>仅显示录音编号和账务证据，不展示录音或转写正文。此处不执行补扣或释放。</p>
      {error && <p role="alert">{error}</p>}
      {items.length === 0 && <p>当前没有待核对任务。</p>}
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <article key={item.reservationKey} className="break-all border-b pb-2">
            <p>
              {item.state} · 账户 {item.accountId} · 会话 {item.conversationId} · 附件{' '}
              {item.attachmentId}
            </p>
            <p>
              最高 {item.maximumCredits} Credit · 实际 {item.expectedCharge ?? '未知'} · 预留{' '}
              {item.reservationStatus ?? '缺失'} · 已扣 {item.chargedNow ?? '未记录'} · 账本{' '}
              {item.ledgerCount} 笔
            </p>
            <p>
              发起 {new Date(item.startedAt).toLocaleString()} · 更新{' '}
              {new Date(item.updatedAt).toLocaleString()}
            </p>
          </article>
        ))}
      </div>
      {cursor !== null && (
        <Button size="sm" variant="ghost" onClick={() => void more()}>
          加载更多
        </Button>
      )}
    </section>
  );
}
