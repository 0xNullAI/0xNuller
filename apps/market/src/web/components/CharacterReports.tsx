import { currentAuthUserId, me, subscribeAuthChanges } from '@0xnullai/auth';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '@0xnullai/ui';
import {
  fetchCharacterReports,
  fetchCharacterConversions,
  reportCharacter,
  resolveCharacterReport,
  type CharacterReportReason,
  type CharacterReport,
} from '../api';
const reasons: Record<CharacterReportReason, string> = {
  unsafe: '危险或违规内容',
  harassment: '骚扰或仇恨',
  privacy: '泄露个人隐私',
  copyright: '侵权或冒用',
  spam: '垃圾信息或诈骗',
};
const subscribe = (notify: () => void) => subscribeAuthChanges(() => notify());
export function CharacterReportAction({
  itemId,
  defaultOpen = false,
}: {
  itemId: string;
  /** Opened from a menu item that already said 举报: show the form at once. */
  defaultOpen?: boolean;
}) {
  const account = useSyncExternalStore(subscribe, currentAuthUserId, () => null);
  return (
    <ReportForm
      key={`${account}:${itemId}`}
      account={account}
      itemId={itemId}
      defaultOpen={defaultOpen}
    />
  );
}
function ReportForm({
  account,
  itemId,
  defaultOpen,
}: {
  account: string | null;
  itemId: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState<CharacterReportReason>('unsafe');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2 text-sm">
      {!defaultOpen && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          举报角色
        </Button>
      )}
      {open && (
        <div className="space-y-2 rounded-xl border border-[var(--surface-border)] p-3">
          <p className="text-xs">
            举报仅供平台审核，不公开举报者身份。每个账户对同一角色只受理一次。
          </p>
          <label>
            举报理由
            <select
              aria-label="举报理由"
              className="ml-2 rounded border p-1"
              value={reason}
              onChange={(event) => setReason(event.target.value as CharacterReportReason)}
            >
              {Object.entries(reasons).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={!account || busy || status === '举报已提交'}
            onClick={async () => {
              setBusy(true);
              setStatus('');
              try {
                await reportCharacter(itemId, reason);
                setStatus('举报已提交');
              } catch (error) {
                setStatus(error instanceof Error ? error.message : '举报暂不可用');
              } finally {
                setBusy(false);
              }
            }}
          >
            {account ? '提交举报' : '请先登录后举报'}
          </Button>
          {status && <p role="status">{status}</p>}
        </div>
      )}
    </div>
  );
}
export function CharacterModeration({ onChanged }: { onChanged: () => void }) {
  const account = useSyncExternalStore(subscribe, currentAuthUserId, () => null);
  const [admin, setAdmin] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (account)
      void me()
        .then((user) => {
          if (active) setAdmin(user?.role === 'admin' ? user.id : null);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [account]);
  if (!account || admin !== account) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <ReportQueue key={account} onChanged={onChanged} />
      <CharacterConversionPanel key={`conversions:${account}`} />
    </div>
  );
}
function CharacterConversionPanel() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof fetchCharacterConversions>>['items']>(
    [],
  );
  const [error, setError] = useState('');
  const load = async () => {
    setError('');
    try {
      setRows((await fetchCharacterConversions()).items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '指标读取失败');
    }
  };
  return (
    <div>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        角色入口指标
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogTitle>角色入口指标</DialogTitle>
          <DialogDescription>
            最近 30 天、至少 5 个账户的公开角色详情打开和「开始聊天」入口完成数；不代表已发送消息。
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          <Button size="sm" onClick={() => void load()}>
            刷新指标
          </Button>
          {!rows.length && <p className="py-3 text-sm">暂无满足人数门槛的数据</p>}
          {rows.map((row) => (
            <p key={row.itemId} className="border-b border-[var(--surface-border)] py-2 text-sm">
              {row.itemName} · 打开 {row.openedAccounts} 账户 · 开始 {row.startedAccounts} 账户
            </p>
          ))}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ReportQueue({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CharacterReport[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState<number | null>(0);
  const load = async (next = 0) => {
    setBusy(true);
    setError('');
    try {
      const page = await fetchCharacterReports(next);
      setRows((previous) => (next ? [...previous, ...page.items] : page.items));
      setOffset(page.nextOffset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '队列读取失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        举报审核
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogTitle className="pr-12">待处理举报</DialogTitle>
          <DialogDescription className="mb-3">
            审核公开角色；隐藏会同时结案该角色的所有待处理举报。
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          <Button size="sm" disabled={busy} onClick={() => void load()}>
            刷新队列
          </Button>
          {!busy && !rows.length && <p className="py-4 text-sm">暂无待处理举报</p>}
          {rows.map((row) => (
            <article
              key={row.id}
              className="space-y-2 border-b border-[var(--surface-border)] py-4"
            >
              <a
                href={`/market?item=${encodeURIComponent(row.itemId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                {row.itemName}
              </a>
              <p className="text-sm">
                {reasons[row.reason]} · {new Date(row.createdAt).toLocaleString()}
              </p>
              <div className="flex flex-wrap gap-2">
                {(['hide', 'dismiss'] as const).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'hide' ? 'destructive' : 'secondary'}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await resolveCharacterReport(row.id, action);
                        onChanged();
                        await load();
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : '审核失败');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {action === 'hide' ? '隐藏角色并结案' : '驳回举报'}
                  </Button>
                ))}
              </div>
            </article>
          ))}
          {offset !== null && rows.length > 0 && (
            <Button disabled={busy} onClick={() => void load(offset)}>
              加载更多
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
