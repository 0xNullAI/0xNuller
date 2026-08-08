import { useEffect, useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Button, Input, Overlay } from '@0xnullai/ui';
import { login, logout, me, register, type AuthUser } from '@0xnullai/auth';

/**
 * 账号入口。
 *
 * **账号是可选增强，不是准入门槛。** 逛市场、进房间、纯本地用 Agent、自带 key 用
 * Voice——一个都不需要登录。所以这个入口不拦路，只是顶栏上的一个按钮。
 *
 * 登录能带来的是跨模块/跨设备的数据归属（波形库、人设、Market 上传），**不包括任何
 * 设备控制权**——那始终是当面授予、随时可撤销的。
 */
export function AccountMenu() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 未登录时后端返回 { user: null }；服务没部署时 fetch 抛错——两种都当作未登录，
    // 不能因为账号服务不可用就挡住匿名使用。
    me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    // 只有已登录的下拉需要点外关闭；未登录走 Overlay，它自己有遮罩。
    if (!open || !user) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, user]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const u =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register({ username: username.trim(), password });
      setUser(u);
      setOpen(false);
      setPassword('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title={user ? `已登录：${user.displayName}` : '登录（可选）'}
      >
        <UserRound className="h-4 w-4" />
        <span className="hidden sm:inline">{user ? user.displayName : '登录'}</span>
      </Button>

      {open && user ? (
        <div className="absolute right-0 top-[calc(100%+8px)] z-[var(--z-shell)] w-56 rounded-[14px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-panel)]">
          <div className="px-2 py-1.5">
            <div className="text-sm font-medium">{user.displayName}</div>
            <div className="text-xs text-[var(--text-faint)]">@{user.username}</div>
          </div>
          <div className="mt-1 border-t border-[var(--surface-border)] pt-1">
            <button
              type="button"
              className="w-full rounded-[10px] px-2 py-1.5 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              onClick={async () => {
                await logout().catch(() => undefined);
                setUser(null);
                setOpen(false);
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      ) : null}

      {open && !user ? (
        <Overlay onDismiss={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={mode === 'login' ? '登录' : '注册'}
            className="w-full max-w-[380px] rounded-[20px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-panel)]"
          >
            <h2 className="text-lg font-semibold">{mode === 'login' ? '登录' : '注册'}</h2>
            <p className="mt-1 text-sm text-[var(--text-soft)]">
              账号是可选的。不登录也能逛市场、进房间、使用全部模块。
            </p>

            <div className="mt-5 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-[var(--text-soft)]">用户名</span>
                <Input
                  value={username}
                  autoComplete="username"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="3–24 位字母、数字、下划线"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-[var(--text-soft)]">密码</span>
                <Input
                  type="password"
                  value={password}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 10 位"
                />
              </label>
            </div>

            {mode === 'register' ? (
              <p className="mt-3 rounded-[10px] bg-[var(--bg-soft)] px-3 py-2 text-xs text-[var(--text-soft)]">
                不需要邮箱。代价是忘记密码将无法找回——请自行妥善保存。
              </p>
            ) : null}

            <p className="mt-3 text-xs text-[var(--text-faint)]">
              登录用于同步波形库、人设与市场归属。
              <span className="text-[var(--text-soft)]">它不会带来任何设备控制权</span>
              ——控制权始终需要当面授予，且随时可以撤销。
            </p>

            {error ? (
              <p className="mt-3 rounded-[10px] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                className="text-xs text-[var(--text-soft)] underline underline-offset-2 hover:text-[var(--text)]"
                onClick={() => {
                  setMode((m) => (m === 'login' ? 'register' : 'login'));
                  setError(null);
                }}
              >
                {mode === 'login' ? '还没有账号？注册' : '已有账号？登录'}
              </button>
              <Button onClick={submit} disabled={busy || !username.trim() || !password}>
                {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
              </Button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}
