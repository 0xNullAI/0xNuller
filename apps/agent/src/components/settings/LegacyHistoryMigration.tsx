import { useEffect, useRef, useState } from 'react';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';
import {
  ServerSessionStore,
  claimUnownedBrowserSessions,
  listUnownedBrowserSessions,
  type UnownedLegacySession,
} from '@dg-agent/storage-browser';

export function LegacyHistoryMigration() {
  const [account, setAccount] = useState(currentAuthUserId);
  const accountRef = useRef(account);
  const [rows, setRows] = useState<UnownedLegacySession[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        const next = currentAuthUserId();
        if (accountRef.current !== next) {
          setRows(null);
          setStatus('');
        }
        accountRef.current = next;
        setAccount(next);
      }),
    [],
  );
  async function inspect() {
    setBusy(true);
    try {
      setRows(await listUnownedBrowserSessions());
      setStatus('');
    } catch {
      setStatus('无法读取旧本地记录，请允许浏览器存储后重试。');
    } finally {
      setBusy(false);
    }
  }
  async function migrate() {
    if (!account || !rows) return;
    const confirmed = account;
    setBusy(true);
    const store = new ServerSessionStore({ migrateLegacy: false });
    try {
      const result = await claimUnownedBrowserSessions(
        store,
        confirmed,
        rows.map((row) => row.key),
        () => currentAuthUserId() === confirmed,
      );
      if (currentAuthUserId() !== confirmed) return;
      setRows(await listUnownedBrowserSessions());
      setStatus(
        `已迁移 ${result.migrated} 个会话；${result.retained} 个未完成，原件继续保留。重新打开聊天即可查看。`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '迁移失败，原件已保留。');
    } finally {
      store.dispose();
      setBusy(false);
    }
  }
  return (
    <section className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] p-3 sm:p-4">
      <h3 className="text-sm font-semibold">旧本地聊天迁移</h3>
      <p className="text-sm text-[var(--text-faint)]">
        已归属当前账户的旧记录会在打开聊天时自动上传并验证。所属不明的记录需要你在这里预览并确认归属。
      </p>
      <Button variant="secondary" disabled={busy} onClick={() => void inspect()}>
        查看所属不明的旧记录
      </Button>
      {rows && (
        <>
          <p className="break-all text-sm">
            所属不明：{rows.length} 个会话。迁移目标账户：{account ?? '未登录，请先登录'}。
          </p>
          <ul className="max-h-48 overflow-y-auto text-sm">
            {rows.map(({ key, session }) => (
              <li key={key} className="border-b border-[var(--surface-border)] py-2">
                {typeof session.metadata?.sessionTitle === 'string'
                  ? session.metadata.sessionTitle
                  : session.messages[0]?.content.slice(0, 60) || '空会话'}
                （{session.messages.length} 条）
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-faint)]">
            确认后以新会话编号复制到该账户；服务器回读验证成功后才清理对应本地原件，不覆盖已有聊天。
          </p>
          <Button disabled={!account || !rows.length || busy} onClick={() => void migrate()}>
            确认这些记录属于我，迁移到当前账户
          </Button>
        </>
      )}
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
    </section>
  );
}
