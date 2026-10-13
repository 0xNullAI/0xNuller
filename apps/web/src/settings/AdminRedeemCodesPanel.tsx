import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, RefreshCw } from 'lucide-react';
import {
  listRedeemBatchCodes,
  listRedeemBatches,
  listRedemptions,
  mintRedeemCodes,
  type RedeemBatch,
  type RedeemBatchCode,
  type RedeemRecord,
} from '@0xnullai/auth';
import { CREDIT_TIERS } from '@0xnullai/auth/credit-tiers';
import { Button, Input } from '@0xnullai/ui';
import { AdminCard, errorText } from './AdminCard';
import { formatCredits, formatTime, redeemCodesCsv } from './admin-billing-view';

const MAX_PER_BATCH = 100;

/** Keys exist in plaintext only in this value, right after minting. */
export interface MintedCodes {
  batchId: string;
  amountCny: number;
  credits: number;
  note: string;
  codes: string[];
  /** Copied or downloaded at least once, so dismissing needs no second confirmation. */
  saved?: boolean;
}

export function AdminRedeemCodesPanel({
  minted,
  onMinted,
  onShowUser,
}: {
  minted: MintedCodes | null;
  onMinted: (minted: MintedCodes | null) => void;
  onShowUser: (username: string) => void;
}) {
  const [batchRefresh, setBatchRefresh] = useState(0);
  return (
    <>
      {minted ? (
        <MintedKeys
          minted={minted}
          onSaved={() => onMinted({ ...minted, saved: true })}
          onDone={() => onMinted(null)}
        />
      ) : (
        <Generator
          onMinted={(next) => {
            onMinted(next);
            setBatchRefresh((x) => x + 1);
          }}
        />
      )}
      <BatchList refresh={batchRefresh} />
      <RedemptionList onShowUser={onShowUser} />
    </>
  );
}

function Generator({ onMinted }: { onMinted: (minted: MintedCodes) => void }) {
  const [amountCny, setAmountCny] = useState(CREDIT_TIERS[0]!.amountCny);
  const [count, setCount] = useState('10');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tier = CREDIT_TIERS.find((item) => item.amountCny === amountCny) ?? CREDIT_TIERS[0]!;
  const quantity = Number(count);
  const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_PER_BATCH;

  return (
    <AdminCard title="生成卡密">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError(null);
          try {
            const result = await mintRedeemCodes({
              amountCny: tier.amountCny,
              count: quantity,
              note: note.trim() || undefined,
            });
            onMinted({
              batchId: result.batch.id,
              amountCny: result.batch.amountCny,
              credits: result.batch.amountCredits,
              note: result.batch.note,
              codes: result.codes,
            });
          } catch (cause) {
            setError(errorText(cause, '生成失败'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div role="radiogroup" aria-label="档位" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CREDIT_TIERS.map((item) => (
            <button
              key={item.amountCny}
              type="button"
              role="radio"
              aria-checked={item.amountCny === tier.amountCny}
              onClick={() => setAmountCny(item.amountCny)}
              className={`rounded-[var(--radius-sm)] border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                item.amountCny === tier.amountCny
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--surface-border)] hover:bg-[var(--bg-strong)]'
              }`}
            >
              <div className="text-sm font-semibold">¥{item.amountCny}</div>
              <div className="text-xs text-[var(--text-faint)]">
                {formatCredits(item.credits)} Credit
              </div>
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_PER_BATCH}
            step={1}
            value={count}
            onChange={(event) => setCount(event.target.value)}
            aria-label="数量"
            placeholder="数量"
          />
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
            aria-label="备注"
            placeholder="备注（可选，如渠道或订单号）"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-[var(--text-faint)]">
            {valid
              ? `${quantity} 张 · 共 ¥${formatCredits(tier.amountCny * quantity)} / ${formatCredits(tier.credits * quantity)} Credit`
              : `数量为 1–${MAX_PER_BATCH}`}
          </span>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? '生成中…' : '生成卡密'}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        ) : null}
      </form>
    </AdminCard>
  );
}

function downloadCsv(minted: MintedCodes) {
  // BOM so spreadsheet apps read the Chinese note as UTF-8.
  const blob = new Blob(['\uFEFF', redeemCodesCsv(minted)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  // Android WebView intercepts download anchors and saves through the native bridge.
  const link = document.createElement('a');
  link.href = url;
  link.download = `redeem-codes-${minted.batchId}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MintedKeys({
  minted,
  onSaved,
  onDone,
}: {
  minted: MintedCodes;
  onSaved: () => void;
  onDone: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <AdminCard title={`已生成 ${minted.codes.length} 张卡密`} label="新卡密">
      <p
        role="alert"
        className="rounded-[var(--radius-xs)] bg-[var(--danger-soft)] p-2 text-xs font-medium text-[var(--danger)]"
      >
        卡密只显示这一次，离开后无法再查看。请立即复制或下载保存。
      </p>
      <div className="mt-2 text-xs text-[var(--text-faint)]">
        ¥{minted.amountCny} · {formatCredits(minted.credits)} Credit
        {minted.note ? ` · ${minted.note}` : ''}
      </div>
      <ol
        aria-label="卡密列表"
        className="mt-2 max-h-72 overflow-y-auto rounded-[var(--radius-xs)] border border-[var(--surface-border)] bg-[var(--bg)] p-2 font-mono text-[11px] leading-5"
      >
        {minted.codes.map((code) => (
          <li key={code} className="select-all break-all">
            {code}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(minted.codes.join('\n'));
              onSaved();
              setNotice('已复制全部卡密');
            } catch {
              setNotice('复制失败，请下载 CSV');
            }
          }}
        >
          <Copy className="mr-1 h-4 w-4" />
          复制全部
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            downloadCsv(minted);
            onSaved();
            setNotice('已下载 CSV');
          }}
        >
          <Download className="mr-1 h-4 w-4" />
          下载 CSV
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!minted.saved && !window.confirm('还没有复制或下载，关闭后无法找回。确定关闭？'))
              return;
            onDone();
          }}
        >
          完成
        </Button>
      </div>
      {notice ? (
        <p role="status" className="mt-2 text-xs text-[var(--text-soft)]">
          {notice}
        </p>
      ) : null}
    </AdminCard>
  );
}

function BatchList({ refresh }: { refresh: number }) {
  const [batches, setBatches] = useState<RedeemBatch[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void listRedeemBatches()
      .then((page) => {
        if (!active) return;
        setBatches(page.batches);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => active && setError(errorText(cause, '批次加载失败')))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [refresh, reload]);

  async function more() {
    if (cursor === null || busy) return;
    setBusy(true);
    try {
      const page = await listRedeemBatches(cursor);
      setBatches((old) => [...old, ...page.batches.filter((b) => !old.some((o) => o.id === b.id))]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(errorText(cause, '批次加载失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminCard
      title="批次"
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-label="刷新批次"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setReload((x) => x + 1);
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {batches.map((batch) => (
          <BatchRow key={batch.id} batch={batch} />
        ))}
      </ul>
      {!busy && batches.length === 0 && !error ? (
        <p className="text-xs text-[var(--text-faint)]">还没有批次</p>
      ) : null}
      {cursor !== null ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 w-full"
          disabled={busy}
          onClick={() => void more()}
        >
          加载更多
        </Button>
      ) : null}
    </AdminCard>
  );
}

function BatchRow({ batch }: { batch: RedeemBatch }) {
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<RedeemBatchCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || codes) return;
    setError(null);
    try {
      setCodes((await listRedeemBatchCodes(batch.id)).codes);
    } catch (cause) {
      setError(errorText(cause, '加载失败'));
    }
  }

  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-[var(--radius-xs)] border border-[var(--surface-border)] bg-[var(--bg)] text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`批次 ${batch.id}`}
        onClick={() => void toggle()}
        className="flex w-full items-start gap-2 p-2 text-left hover:bg-[var(--bg-strong)]"
      >
        <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-faint)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium">
              ¥{batch.amountCny} · {formatCredits(batch.amountCredits)} Credit × {batch.count}
            </span>
            <span className="tabular-nums text-[var(--text-soft)]">
              已兑换 {batch.redeemed}/{batch.count}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[var(--text-faint)]">
            {[batch.note, batch.operator ? `@${batch.operator}` : null, formatTime(batch.createdAt)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-[var(--surface-border)] p-2">
          {error ? <p className="text-[var(--danger)]">{error}</p> : null}
          {!codes && !error ? <p className="text-[var(--text-faint)]">加载中…</p> : null}
          {codes ? (
            <ul aria-label="批次卡密" className="grid gap-1 sm:grid-cols-2">
              {codes.map((code) => (
                <li key={code.id} className="flex justify-between gap-2">
                  <span className="font-mono">••••{code.tail}</span>
                  <span
                    className={
                      code.redeemedAt ? 'text-[var(--text-soft)]' : 'text-[var(--text-faint)]'
                    }
                  >
                    {code.redeemedAt
                      ? `已兑换 · ${code.redeemedBy ? `@${code.redeemedBy}` : '已注销用户'}`
                      : '未使用'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RedemptionList({ onShowUser }: { onShowUser: (username: string) => void }) {
  const [items, setItems] = useState<RedeemRecord[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listRedemptions()
      .then((page) => {
        if (!active) return;
        setItems(page.redemptions);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => active && setError(errorText(cause, '兑换记录加载失败')))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, []);

  async function more() {
    if (cursor === null || busy) return;
    setBusy(true);
    try {
      const page = await listRedemptions(cursor);
      setItems((old) => [
        ...old,
        ...page.redemptions.filter((r) => !old.some((o) => o.id === r.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(errorText(cause, '兑换记录加载失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminCard title="最近兑换">
      {error ? (
        <p role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-[var(--surface-border)] text-xs">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono">••••{item.tail}</span>
              {item.redeemedBy ? (
                <button
                  type="button"
                  onClick={() => onShowUser(item.redeemedBy!)}
                  className="text-[var(--accent)] hover:underline"
                  aria-label={`查看 @${item.redeemedBy} 的账单`}
                >
                  @{item.redeemedBy}
                </button>
              ) : (
                <span className="text-[var(--text-faint)]">已注销用户</span>
              )}
            </span>
            <span className="flex items-baseline gap-2 text-[var(--text-faint)]">
              <span className="tabular-nums text-[var(--success)]">
                +{formatCredits(item.amountCredits)}
              </span>
              <span>¥{item.amountCny}</span>
              <span className="tabular-nums">{formatTime(item.redeemedAt)}</span>
            </span>
            {item.note ? (
              <span className="w-full truncate text-[var(--text-faint)]">{item.note}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {!busy && items.length === 0 && !error ? (
        <p className="text-xs text-[var(--text-faint)]">暂无兑换</p>
      ) : null}
      {cursor !== null ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 w-full"
          disabled={busy}
          onClick={() => void more()}
        >
          加载更多
        </Button>
      ) : null}
    </AdminCard>
  );
}
