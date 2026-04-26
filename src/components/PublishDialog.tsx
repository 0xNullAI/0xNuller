import { useEffect, useState } from 'react';
import type { PageMeta } from '../lib/pages';
import { clearToken, getToken, setToken, submitEdit, whoami } from '../lib/github';

interface PublishDialogProps {
  page: PageMeta;
  content: string;
  onClose: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'verified'; login: string }
  | { kind: 'submitting' }
  | { kind: 'success'; prUrl: string }
  | { kind: 'error'; message: string };

/**
 * Modal that walks the user through:
 *   1. pasting / saving a GitHub Personal Access Token
 *   2. confirming a commit message
 *   3. clicking "Open PR" → app creates a branch, commits, and opens a PR
 */
export function PublishDialog({ page, content, onClose }: PublishDialogProps) {
  const initialToken = getToken() ?? '';
  const [token, setTokenState] = useState(initialToken);
  const [message, setMessage] = useState(`docs(${page.id}): edit via DG-Wiki`);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // If a token already exists, validate it on open.
  useEffect(() => {
    if (initialToken) {
      verify(initialToken).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(t: string): Promise<void> {
    setStatus({ kind: 'verifying' });
    try {
      const me = await whoami(t);
      setStatus({ kind: 'verified', login: me.login });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function publish(): Promise<void> {
    if (!token) {
      setStatus({ kind: 'error', message: '请先填入 GitHub Token' });
      return;
    }
    setToken(token);
    setStatus({ kind: 'submitting' });
    try {
      const result = await submitEdit({
        token,
        filePath: page.sourcePath,
        content,
        pageId: page.id,
        message,
      });
      setStatus({ kind: 'success', prUrl: result.prUrl });
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.55)' }}
      onClick={onClose}
    >
      <div
        className="dg-card max-w-[560px] w-full p-7 reveal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-3xl font-extrabold tracking-tight text-[var(--text)]">
            提交修改到 GitHub
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-[var(--text-faint)] hover:text-[var(--text)]"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <p className="text-sm text-[var(--text-soft)] leading-relaxed mb-5">
          DG-Wiki 是纯静态站点，没有后端，要把你浏览器里的修改同步回 GitHub 仓库需要用一个
          <strong className="text-[var(--text)]"> Personal Access Token</strong>
          。点击「保存 Token + 提交 PR」后，会在 <code className="text-[var(--accent-strong)]">{page.sourcePath}</code> 上自动创建分支、提交内容、开 PR。
        </p>

        {/* Token field */}
        <label className="block mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-[var(--text-faint)]">
              github personal access token
            </span>
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=DG-Wiki%20edit"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-[var(--accent-strong)] underline-offset-2 hover:underline"
            >
              ↗ 生成新 token
            </a>
          </div>
          <input
            type="password"
            value={token}
            onChange={(e) => setTokenState(e.target.value)}
            onBlur={() => token && verify(token)}
            placeholder="ghp_..."
            className="w-full px-3 py-2 bg-[var(--bg-strong)] border border-[var(--surface-border)] rounded-[var(--radius-sm)] font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>

        <p className="text-xs text-[var(--text-faint)] mb-5 leading-relaxed">
          需要 <code className="text-[var(--accent-strong)]">repo</code> 权限（或 fine-grained token：对 <code className="text-[var(--accent-strong)]">0xNullAI/DG-Wiki</code> 的
          Contents 和 Pull requests 都开 read+write）。Token 仅保存在你浏览器的 localStorage，
          <strong className="text-[var(--text)]">不会上传到任何服务器</strong>。
        </p>

        {/* Status badge */}
        <div className="mb-5">
          <StatusBadge status={status} />
        </div>

        {/* Commit message */}
        <label className="block mb-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.15em] text-[var(--text-faint)] mb-1">
            commit message
          </div>
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--bg-strong)] border border-[var(--surface-border)] rounded-[var(--radius-sm)] font-mono text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>

        {/* Actions */}
        <div className="flex justify-between items-center gap-2">
          <div>
            {token ? (
              <button
                type="button"
                onClick={() => {
                  clearToken();
                  setTokenState('');
                  setStatus({ kind: 'idle' });
                }}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--text-faint)] hover:text-[var(--danger)]"
              >
                ↺ 清除已保存的 token
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="dg-button">
              取消
            </button>
            <button
              type="button"
              onClick={publish}
              disabled={!token || status.kind === 'submitting'}
              className="dg-button is-primary"
              style={{ opacity: !token || status.kind === 'submitting' ? 0.4 : 1 }}
            >
              {status.kind === 'submitting' ? '提交中…' : '保存 token + 提交 PR'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'verifying':
      return (
        <div className="dg-pill" style={{ borderColor: 'var(--accent)', color: 'var(--accent-strong)' }}>
          ◌ 校验 token…
        </div>
      );
    case 'verified':
      return (
        <div className="dg-pill" style={{ borderColor: 'var(--success)', color: 'var(--success)' }}>
          ✓ 已识别 @{status.login}
        </div>
      );
    case 'submitting':
      return (
        <div className="dg-pill" style={{ borderColor: 'var(--accent)', color: 'var(--accent-strong)' }}>
          ⟳ 创建分支 / 提交内容 / 开 PR…
        </div>
      );
    case 'success':
      return (
        <a
          href={status.prUrl}
          target="_blank"
          rel="noreferrer"
          className="dg-pill"
          style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
        >
          ✓ PR 已创建 ↗ {status.prUrl.replace('https://github.com/', '')}
        </a>
      );
    case 'error':
      return (
        <div
          className="dg-pill"
          style={{
            borderColor: 'var(--danger)',
            color: 'var(--danger)',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textTransform: 'none',
            letterSpacing: 0,
          }}
          title={status.message}
        >
          ✗ {status.message}
        </div>
      );
  }
}
