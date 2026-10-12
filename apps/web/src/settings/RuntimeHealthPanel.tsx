import { useEffect, useState } from 'react';
import { getAdminRuntimeHealth, type AdminRuntimeHealth } from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';

const WORKER_LABELS: Record<string, string> = {
  auth: 'Auth',
  chat: 'Chat',
  market: 'Market',
  voice: 'Voice',
  'llm-proxy': 'LLM Proxy',
};

function seen(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

/** Read-only 运行状况: last 24h server errors per Worker and top client error signatures. */
export function RuntimeHealthPanel() {
  const [health, setHealth] = useState<AdminRuntimeHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    getAdminRuntimeHealth().then(
      (value) => {
        if (!active) return;
        setHealth(value);
        setError(null);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '加载失败');
      },
    );
    return () => {
      active = false;
    };
  }, [refresh]);

  return (
    <div className="mb-6 rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">运行状况</h2>
        <Button size="sm" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
          刷新
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-[var(--danger,#dc2626)]">{error}</p> : null}
      {!health && !error ? <p className="mt-2 text-xs text-[var(--text-faint)]">加载中…</p> : null}
      {health ? (
        <div className="mt-2 space-y-3 text-xs">
          <div>
            <div className="text-[var(--text-faint)]">近 24 小时服务端错误</div>
            {health.server.length === 0 ? (
              <p className="mt-1 text-[var(--text-soft)]">无</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {health.server.map((row) => (
                  <li key={row.worker} className="flex flex-wrap justify-between gap-x-3">
                    <span className="font-medium">{WORKER_LABELS[row.worker] ?? row.worker}</span>
                    <span className="tabular-nums text-[var(--text-soft)]">
                      5xx {row.http5xx} · 异常 {row.exceptions} · 定时 {row.scheduled} ·{' '}
                      {seen(row.lastSeenAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-[var(--text-faint)]">
              近 24 小时客户端错误 <span className="tabular-nums">{health.clientTotal}</span> 次
            </div>
            {health.signatures.length === 0 ? null : (
              <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto">
                {health.signatures.map((row) => (
                  <li
                    key={row.signature}
                    className="rounded-[var(--radius-xs)] bg-[var(--bg-soft)] p-2"
                  >
                    <div className="break-words font-medium">{row.message}</div>
                    <div className="mt-0.5 text-[var(--text-faint)]">
                      <span className="tabular-nums">{row.count}</span> 次 ·{' '}
                      {row.moduleId ?? '外壳'} · {row.platform} {row.version} · 最近{' '}
                      {seen(row.lastSeenAt)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
