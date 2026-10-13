import { useEffect, useRef, useState } from 'react';
import {
  approveAdminCreditRedPacket,
  grantCreditGift,
  listAdminCreditRedPackets,
  lookupAdminCreditTarget,
  rejectAdminCreditRedPacket,
} from '@0xnullai/auth';
import { Button, Input } from '@0xnullai/ui';
import { AdminCard, errorText } from './AdminCard';

type CreditTarget = Awaited<ReturnType<typeof lookupAdminCreditTarget>>;
type RedPacket = Awaited<ReturnType<typeof listAdminCreditRedPackets>>['items'][number];

export function AdminGiftPanel() {
  return (
    <>
      <GiftForm />
      <RedPackets />
    </>
  );
}

function GiftForm() {
  const [username, setUsername] = useState('');
  const [amount, setAmount] = useState('1000');
  const [reason, setReason] = useState('');
  const [candidate, setCandidate] = useState<CreditTarget | null>(null);
  const [target, setTarget] = useState<CreditTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lookupSequence = useRef(0);

  async function lookup() {
    if (!username.trim()) return;
    const sequence = ++lookupSequence.current;
    setError(null);
    try {
      const result = await lookupAdminCreditTarget(username);
      if (sequence === lookupSequence.current) setCandidate(result);
    } catch (cause) {
      if (sequence !== lookupSequence.current) return;
      setCandidate(null);
      setError(errorText(cause, '找不到用户'));
    }
  }

  const credits = Number(amount);
  const amountValid = Number.isSafeInteger(credits) && credits >= 1 && credits <= 20_000;

  return (
    <AdminCard title="赠送 Credit">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setNotice(null);
          setSubmitting(true);
          try {
            const result = await grantCreditGift({
              username: username.trim(),
              amountCredits: credits,
              reason: reason.trim(),
            });
            setNotice(`已赠送 @${result.username} ${result.amountCredits} Credit`);
            setReason('');
          } catch (cause) {
            setError(errorText(cause, '赠送入账失败'));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <p className="text-xs leading-relaxed text-[var(--text-faint)]">
          活动或直接赠与，不计入收入。
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setTarget(null);
              setCandidate(null);
              lookupSequence.current += 1;
            }}
            onBlur={() => void lookup()}
            placeholder="用户名"
            aria-label="赠送用户名"
            required
          />
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            inputMode="numeric"
            min={1}
            max={20_000}
            step={1}
            placeholder="Credit 数量（1–20,000）"
            aria-label="赠送 Credit 数量"
            required
          />
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            minLength={2}
            placeholder="赠送原因（必填）"
            aria-label="赠送原因"
            required
          />
          <Button type="submit" disabled={submitting || reason.trim().length < 2 || !amountValid}>
            {submitting ? '赠送中…' : '确认赠送'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-faint)]">
          离开用户名输入框会查询账号以便核对；服务端仍按用户名校验。
        </p>
        {candidate && !target ? (
          <TargetConfirmation
            target={candidate}
            actionLabel="选择此账号"
            onConfirm={() => setTarget(candidate)}
          />
        ) : null}
        {target ? (
          <TargetConfirmation target={target} amount={`${amount} Credit`} selected />
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-2 text-xs text-[var(--success)]">
            {notice}
          </p>
        ) : null}
      </form>
    </AdminCard>
  );
}

function RedPackets() {
  const [items, setItems] = useState<RedPacket[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listAdminCreditRedPackets()
      .then((result) => active && setItems(result.items))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await run();
      setItems((await listAdminCreditRedPackets()).items);
    } catch (cause) {
      setError(errorText(cause, '操作失败'));
    } finally {
      setBusyId(null);
    }
  }

  const pending = items.filter((item) => item.status === 'pending');
  return (
    <AdminCard title="口令红包申请">
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <div className="space-y-2">
        {pending.map((item) => (
          <div
            key={item.id}
            className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                @{item.username} · {item.code}
              </span>
              <span className="text-xs text-[var(--text-faint)]">
                {new Date(item.createdAt).toLocaleString()}
              </span>
            </div>
            {item.note ? <p className="mt-1 text-xs text-[var(--text-soft)]">{item.note}</p> : null}
            <div className="mt-2 flex gap-2">
              <Input
                type="number"
                min={1}
                max={20000}
                value={amounts[item.id] ?? '1000'}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [item.id]: event.target.value }))
                }
                aria-label="红包 Credit 数量"
              />
              <Button
                size="sm"
                disabled={busyId === item.id}
                onClick={() =>
                  void act(item.id, () =>
                    approveAdminCreditRedPacket(item.id, Number(amounts[item.id] ?? '1000')),
                  )
                }
              >
                确认发送
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busyId === item.id}
                onClick={() => {
                  const reason = window.prompt('请输入拒绝原因')?.trim();
                  if (!reason) return;
                  void act(item.id, () => rejectAdminCreditRedPacket(item.id, reason));
                }}
              >
                拒绝
              </Button>
            </div>
          </div>
        ))}
        {pending.length === 0 ? (
          <p className="text-xs text-[var(--text-faint)]">暂无待处理申请</p>
        ) : null}
      </div>
    </AdminCard>
  );
}

function TargetConfirmation({
  target,
  amount,
  actionLabel,
  onConfirm,
  selected = false,
}: {
  target: CreditTarget;
  amount?: string;
  actionLabel?: string;
  onConfirm?: () => void;
  selected?: boolean;
}) {
  return (
    <div className="mt-3 rounded-[var(--radius-xs)] border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-xs">
      <div className="font-semibold">{selected ? '已选择目标账号' : '已找到，请确认账号'}</div>
      <div className="mt-1 grid gap-1 text-[var(--text-soft)] sm:grid-cols-2">
        <span>用户名：@{target.user.username}</span>
        <span>显示名：{target.user.displayName || '未设置'}</span>
        <span className="break-all">账号 ID：{target.user.id}</span>
        <span>邮箱：{target.user.email || '未设置'}</span>
        <span>邮箱状态：{target.user.emailVerified ? '已验证' : '未验证'}</span>
        <span>注册时间：{new Date(target.createdAt).toLocaleString()}</span>
        <span>总余额：{target.credit.total} Credit</span>
        <span>占用余额：{target.credit.reserved} Credit</span>
        <span>当前余额：{target.credit.available} Credit</span>
        {amount ? <span>本次：{amount}</span> : null}
      </div>
      {onConfirm && actionLabel ? (
        <Button type="button" size="sm" className="mt-3" onClick={onConfirm}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
