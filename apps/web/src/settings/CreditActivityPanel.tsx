import { useEffect, useRef, useState } from 'react';
import { getCreditActivity, type CreditActivity, type CreditActivityEntry } from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';
const LABELS: Record<string, string> = {
  referral_reward: '邀请奖励',
  market_download_reward: '内容下载奖励',
  market_tip: '创作者 Credit 打赏',
  red_packet: '口令红包',
  manual_purchase: '充值到账',
  admin_gift: '管理员赠送',
  usage: 'AI 使用',
  refund: '退款',
  support_adjustment: '客服调整',
  billing_correction: '账务冲正',
};
const TYPES: Record<string, string> = {
  agent: '文字',
  voice: '语音',
  video: '视觉／旧视频记录',
  generated_video: '生成视频',
  image: '图片',
  selfie: '情境自拍',
  proactive: '主动AI消息',
  tts: '朗读',
};
function usage(type: string | null) {
  return TYPES[type ?? ''] ?? '模态未知';
}
const STATES: Record<string, string> = {
  pending: '待结算',
  settled: '已结算',
  released: '已释放',
  recorded: '已记录（旧账本）',
  posted: '已入账',
};
const ERRORS: Record<string, string> = {
  voice_hold_expired: '语音冻结已过期，已转人工核对；未追加扣费',
  needs_review: '需要人工核对，不能据此推算费用',
  ledger_mismatch: '扣款与预留状态不一致，需要核对',
  ledger_missing: '结算状态与账本记录不完整，需要核对',
  expired_hold: '预留已过有效期，不再计入冻结余额',
  provider_unconfirmed: '供应商提交结果未确认',
  generation_failed: '生成失败',
};
export function CreditActivityPanel({ accountId }: { accountId: string }) {
  return <Activity key={accountId} />;
}
function Activity() {
  const [data, setData] = useState<CreditActivity | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void getCreditActivity()
      .then((result) => {
        if (active) {
          setData(result);
          setBusy(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : '读取失败');
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [reload]);
  async function more() {
    if (lock.current || busy || !data?.nextCursor) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await getCreditActivity(data.nextCursor);
      if (alive.current)
        setData((previous) => ({
          ...result,
          entries: [
            ...(previous?.entries ?? []),
            ...result.entries.filter((e) => !previous?.entries.some((old) => old.id === e.id)),
          ],
        }));
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function row(entry: CreditActivityEntry) {
    return (
      <article
        key={entry.id}
        className="border-b border-[var(--surface-border)] py-2 text-xs last:border-b-0"
      >
        <div className="flex justify-between gap-2">
          <span>
            {entry.kind === 'refund' && entry.amountCredits !== null && entry.amountCredits < 0
              ? '退款扣回'
              : entry.kind === 'admin_gift' && entry.referenceId === 'welcome'
                ? '新用户体验额度'
                : (LABELS[entry.kind] ?? '账本调整')}
            {entry.kind === 'usage' ? ` · ${usage(entry.usageType)}` : ''}
          </span>
          <strong className="shrink-0 tabular-nums">
            {entry.amountCredits === null
              ? '未记扣款'
              : `${entry.amountCredits > 0 ? '+' : ''}${entry.amountCredits} Credit`}
          </strong>
        </div>
        <p className="text-[var(--text-soft)]">
          {entry.kind === 'usage' && entry.reservedCredits !== null ? '请求开始：' : '记账时间：'}
          {new Date(entry.createdAt).toLocaleString()}
          {entry.durationMs !== null ? ` · ${Math.ceil(entry.durationMs / 1000)} 秒` : ''}
        </p>
        <p>
          {STATES[entry.status] ?? '状态未知'}
          {entry.reservedCredits !== null ? ` · 原预留 ${entry.reservedCredits} Credit` : ''}
          {entry.holdActive ? ' · 仍占用余额' : ''}
        </p>
        {entry.anomaly && (
          <p className="text-[var(--text-soft)]">{ERRORS[entry.anomaly] ?? '状态需核对'}</p>
        )}
        <details>
          <summary className="cursor-pointer text-[var(--text-faint)]">交易详情</summary>
          <p className="break-all">编号：{entry.referenceId}</p>
          {entry.kind === 'usage' && (
            <>
              {(!entry.roomId || entry.conversationId) && (
                <p className="break-all">
                  会话：{entry.conversationId ?? '未知（原记录未保存关联）'}
                </p>
              )}
              <p className="break-all">任务：{entry.taskId ?? '未知（原记录未保存关联）'}</p>
              <p className="break-all">运行：{entry.runId ?? '未知（原记录未保存关联）'}</p>
              {entry.relationshipId && (
                <p className="break-all">角色关系：{entry.relationshipId}</p>
              )}
              {entry.scheduleId && <p className="break-all">主动消息计划：{entry.scheduleId}</p>}
              {entry.roomId && <p className="break-all">群聊：{entry.roomId}</p>}
              {entry.triggerId && <p className="break-all">触发消息：{entry.triggerId}</p>}
              {entry.roleId && <p className="break-all">群内角色：{entry.roleId}</p>}
              {entry.taskState && <p>任务状态：{entry.taskState}</p>}
              {entry.recoveryState && <p>账务恢复状态：{entry.recoveryState}</p>}
            </>
          )}
          {entry.model && <p className="break-all">模型：{entry.model}</p>}
          <p>价格版本：{entry.priceVersion ?? '未知（原记录未保存）'}</p>
        </details>
      </article>
    );
  }
  return (
    <section aria-label="统一 Credit 账本" className="space-y-3">
      <p className="text-xs text-[var(--text-soft)]">
        托管文字、语音、视觉及生成媒体共用此余额。预留是暂时占用，扣款、释放及异常以每条状态为准。此处只读，不发起重试或扣款。BYOK
        的提供商费用不进入此账本。创作者奖励用于站内 AI，不支持提现。
      </p>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          setError('');
          setBusy(true);
          setReload((v) => v + 1);
        }}
      >
        刷新账本
      </Button>
      {error && (
        <p role="alert" className="text-xs">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs">
          正在读取账本…
        </p>
      )}
      <div className="max-h-80 overflow-y-auto">
        {data?.entries.map(row)}
        {data && !data.entries.length && <p className="text-xs">暂无 Credit 记录</p>}
      </div>
      {data?.nextCursor && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void more()}>
          更早的记录
        </Button>
      )}
    </section>
  );
}
