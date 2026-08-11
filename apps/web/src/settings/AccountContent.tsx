import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { Avatar, Button, Input } from '@0xnullai/ui';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import {
  avatarSrc,
  deleteAccount,
  login,
  logout,
  register,
  requestProfileView,
  type AuthUser,
} from '@0xnullai/auth';

function Agreement() {
  return (
    <div className="mt-3 max-h-[220px] overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3 text-xs leading-relaxed text-[var(--text-soft)]">
      <p className="font-semibold text-[var(--text)]">使用须知</p>
      {SAFETY_NOTICE_SECTIONS.map((section) => (
        <div key={section.title} className="mt-3">
          <p className="font-medium text-[var(--text)]">{section.title}</p>
          <ul className="mt-1 space-y-1">
            {section.items.map((item) => (
              <li key={item} className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AccountContent({
  user,
  onUser,
  onDone,
}: {
  user: AuthUser | null;
  onUser: (user: AuthUser | null) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register({ username: username.trim(), email: email.trim(), password });
      onUser(next);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div>
        <div className="flex items-center gap-3">
          <Avatar
            name={user.displayName}
            username={user.username}
            src={avatarSrc(user.avatarUrl)}
            size={44}
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-base font-semibold">{user.displayName}</div>
              {user.role === 'admin' ? (
                <span className="shrink-0 rounded-full border border-[var(--accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                  管理员
                </span>
              ) : null}
            </div>
            <div className="truncate text-sm text-[var(--text-faint)]">@{user.username}</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            onDone();
            requestProfileView(user.username);
          }}
          className="mt-5 flex w-full items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2.5 text-left hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <UserRound className="h-4 w-4 text-[var(--text-soft)]" />
          <span className="text-sm font-medium">我的主页</span>
        </button>

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            className="text-xs text-[var(--danger)] underline underline-offset-2"
            onClick={async () => {
              if (!window.confirm('永久删除账户和同步数据？')) return;
              await deleteAccount().catch(() => undefined);
              onUser(null);
              onDone();
            }}
          >
            注销账户
          </button>
          <Button
            variant="secondary"
            onClick={async () => {
              await logout().catch(() => undefined);
              onUser(null);
              onDone();
            }}
          >
            退出登录
          </Button>
        </div>
      </div>
    );
  }

  const registerMode = mode === 'register';
  return (
    <div>
      <h2 className="text-lg font-semibold">{registerMode ? '注册' : '登录'}</h2>
      <div className="mt-5 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">用户名</span>
          <Input
            value={username}
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3–24 位字母、数字、下划线"
          />
        </label>
        {registerMode && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">邮箱</span>
            <Input
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--text-soft)]">密码</span>
          <Input
            type="password"
            value={password}
            autoComplete={registerMode ? 'new-password' : 'current-password'}
            onChange={(event) => setPassword(event.target.value)}
            minLength={registerMode ? 8 : undefined}
            placeholder={registerMode ? '至少 8 位' : '输入密码'}
          />
        </label>
      </div>

      {registerMode && (
        <>
          <Agreement />
          <label className="mt-2 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-soft)]">我已阅读并同意上述内容</span>
          </label>
        </>
      )}

      {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-xs text-[var(--text-soft)] underline underline-offset-2"
          onClick={() => {
            setMode(registerMode ? 'login' : 'register');
            setError(null);
          }}
        >
          {registerMode ? '已有账户？登录' : '没有账户？注册'}
        </button>
        <Button
          onClick={() => void submit()}
          disabled={
            busy ||
            !username.trim() ||
            !password ||
            (registerMode && (password.length < 8 || !email.trim() || !agreed))
          }
        >
          {busy ? '处理中…' : registerMode ? '注册' : '登录'}
        </Button>
      </div>
    </div>
  );
}
