import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Avatar, Button, Input } from '@0xnullai/ui';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import {
  avatarSrc,
  deleteAccount,
  login,
  logout,
  confirmEmailVerification,
  register,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
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
  const initialResetToken = new URLSearchParams(window.location.search).get('reset') ?? '';
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(
    initialResetToken ? 'reset' : 'login',
  );
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('verify');
    if (!token) return;
    void confirmEmailVerification(token)
      .then(() => {
        setNotice('邮箱验证成功');
        const url = new URL(window.location.href);
        url.searchParams.delete('verify');
        window.history.replaceState(null, '', url);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '验证失败'));
  }, []);

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

        {user.email ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm">{user.email}</div>
              <div className="text-xs text-[var(--text-faint)]">
                {user.emailVerified ? '已验证' : '尚未验证'}
              </div>
            </div>
            {!user.emailVerified && user.emailAvailable ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  setError(null);
                  try {
                    await requestEmailVerification();
                    setNotice('验证邮件已发送');
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : '发送失败');
                  }
                }}
              >
                发送验证邮件
              </Button>
            ) : !user.emailVerified ? (
              <span className="shrink-0 text-xs text-[var(--text-faint)]">邮件服务待启用</span>
            ) : null}
          </div>
        ) : null}

        {notice && <p className="mt-3 text-xs text-[var(--success)]">{notice}</p>}
        {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}

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
  const forgotMode = mode === 'forgot';
  const resetMode = mode === 'reset';

  async function submitRecovery() {
    setBusy(true);
    setError(null);
    try {
      if (forgotMode) {
        await requestPasswordReset(email.trim());
        setNotice('如果邮箱已注册，重置邮件将很快送达');
      } else {
        await resetPassword(initialResetToken, password);
        setNotice('密码已更新，请重新登录');
        setMode('login');
        const url = new URL(window.location.href);
        url.searchParams.delete('reset');
        window.history.replaceState(null, '', url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold">
        {registerMode ? '注册' : forgotMode ? '找回密码' : resetMode ? '设置新密码' : '登录'}
      </h2>
      <div className="mt-5 flex flex-col gap-3">
        {!forgotMode && !resetMode ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">用户名</span>
            <Input
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              placeholder="3–24 位字母、数字、下划线"
            />
          </label>
        ) : null}
        {(registerMode || forgotMode) && (
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
        {!forgotMode && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">密码</span>
            <Input
              type="password"
              value={password}
              autoComplete={registerMode || resetMode ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              minLength={registerMode ? 8 : undefined}
              placeholder={registerMode || resetMode ? '至少 8 位' : '输入密码'}
            />
          </label>
        )}
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
      {notice && <p className="mt-3 text-xs text-[var(--success)]">{notice}</p>}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-xs text-[var(--text-soft)] underline underline-offset-2"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? '没有账户？注册' : '返回登录'}
        </button>
        <Button
          onClick={() => void (forgotMode || resetMode ? submitRecovery() : submit())}
          disabled={
            busy ||
            (!forgotMode && !resetMode && !username.trim()) ||
            (!forgotMode && (!password || ((registerMode || resetMode) && password.length < 8))) ||
            (forgotMode && !email.trim()) ||
            (registerMode && (password.length < 8 || !email.trim() || !agreed))
          }
        >
          {busy
            ? '处理中…'
            : registerMode
              ? '注册'
              : forgotMode
                ? '发送重置邮件'
                : resetMode
                  ? '更新密码'
                  : '登录'}
        </Button>
      </div>
      {mode === 'login' ? (
        <button
          type="button"
          className="mt-3 text-xs text-[var(--text-soft)] underline underline-offset-2"
          onClick={() => {
            setMode('forgot');
            setError(null);
          }}
        >
          忘记密码
        </button>
      ) : null}
    </div>
  );
}
