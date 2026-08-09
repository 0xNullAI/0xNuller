import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { Avatar, Button, Input, Overlay } from '@0xnullai/ui';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import {
  deleteAccount,
  login,
  logout,
  register,
  requestProfileView,
  type AuthUser,
} from '@0xnullai/auth';

/**
 * Account. Login / registration / signed-in info all live in this one dialog.
 *
 * **Registration must show the user agreement and require consent.** The agreement
 * body contains the full pre-use safety notice (`@dg-kit/safety`'s
 * SAFETY_NOTICE_SECTIONS, the only copy in the entire system). This is one of the
 * places the safety notice landed after being moved out of the startup dialog; the
 * other is the first device connection — because accounts are optional, putting it
 * only in the registration flow means users who never register never see it.
 */

function Agreement() {
  return (
    <div className="mt-3 max-h-[240px] overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
      <p className="font-semibold text-[var(--text)]">使用前请阅读</p>
      <p className="mt-1">
        本软件会驱动设备向人体输出电流。继续即表示你已理解相关风险，并愿意自行承担。
      </p>
      {SAFETY_NOTICE_SECTIONS.map((section) => (
        <div key={section.title} className="mt-3">
          <p className="font-medium text-[var(--text)]">{section.title}</p>
          <ul className="mt-1 space-y-1">
            {section.items.map((item) => (
              <li key={item} className="flex gap-1.5">
                <span className="text-[var(--text-faint)]">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AccountDialog({
  user,
  onUser,
  onClose,
}: {
  user: AuthUser | null;
  onUser: (u: AuthUser | null) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const u =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register({ username: username.trim(), password });
      onUser(u);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="账户"
        className="max-h-[min(680px,calc(100dvh-2rem))] w-[min(420px,calc(100vw-2rem))] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-panel)] sm:p-6"
      >
        {user ? (
          <>
            <div className="flex items-center gap-3">
              <Avatar name={user.displayName} username={user.username} size={44} />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">{user.displayName}</div>
                <div className="truncate text-sm text-[var(--text-faint)]">@{user.username}</div>
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-[var(--text-faint)]">
              账户用于同步波形库、场景与市场归属。
              <span className="text-[var(--text-soft)]">它不带来任何设备控制权</span>
              ——控制权始终需要当面授予，且随时可以撤销。
            </p>

            {/* Editing used to be a stack of fields at the bottom of this
                dialog, where nothing showed what other people would end up
                seeing. It now happens on the profile itself, in place — so
                this is an entry point rather than a form, and the account
                dialog goes back to being only about identity and session. */}
            <button
              type="button"
              onClick={() => {
                onClose();
                requestProfileView(user.username);
              }}
              className="mt-5 flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2.5 text-left transition-colors duration-[var(--dur)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <UserRound className="h-4 w-4 shrink-0 text-[var(--text-soft)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">我的主页</span>
                <span className="block text-[10px] text-[var(--text-faint)]">
                  简介、地区、链接与可见性，全部选填
                </span>
              </span>
            </button>

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                className="text-xs text-[var(--danger)] underline underline-offset-2"
                onClick={async () => {
                  if (!window.confirm('注销后账户与全部同步数据将被永久删除，无法恢复。继续？'))
                    return;
                  await deleteAccount().catch(() => undefined);
                  onUser(null);
                  onClose();
                }}
              >
                注销账户
              </button>
              <Button
                variant="secondary"
                onClick={async () => {
                  await logout().catch(() => undefined);
                  onUser(null);
                  onClose();
                }}
              >
                退出登录
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">{mode === 'login' ? '登录' : '注册'}</h2>
            <p className="mt-1 text-sm text-[var(--text-soft)]">
              账户是可选的。不登录也能使用全部功能。
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

            {mode === 'register' && (
              <>
                <Agreement />
                <label className="mt-2 flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span className="text-xs text-[var(--text-soft)]">
                    我已阅读并同意上述内容。不需要邮箱，代价是忘记密码将无法找回。
                  </span>
                </label>
              </>
            )}

            {error && (
              <p className="mt-3 rounded-[var(--radius-ctl)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]">
                {error}
              </p>
            )}

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                className="text-xs text-[var(--text-soft)] underline underline-offset-2 hover:text-[var(--text)]"
                onClick={() => {
                  setMode((m) => (m === 'login' ? 'register' : 'login'));
                  setError(null);
                }}
              >
                {mode === 'login' ? '还没有账户？注册' : '已有账户？登录'}
              </button>
              <Button
                onClick={submit}
                disabled={busy || !username.trim() || !password || (mode === 'register' && !agreed)}
              >
                {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
