import { useEffect, useState } from 'react';
import { Check, Copy, Gift, UserRound } from 'lucide-react';
import { Avatar, Button, Input } from '@0xnullai/ui';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import {
  avatarSrc,
  deleteAccount,
  getReferralSummary,
  login,
  logout,
  me,
  confirmEmailVerification,
  register,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  requestProfileView,
  type AuthUser,
  type ReferralSummary,
} from '@0xnullai/auth';

function Agreement() {
  return (
    <details className="group mt-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] text-xs leading-relaxed text-[var(--text-soft)]">
      <summary className="cursor-pointer list-none px-3 py-2.5 font-medium text-[var(--text)] marker:hidden">
        使用须知
        <span className="ml-2 font-normal text-[var(--text-faint)] group-open:hidden">
          点击展开
        </span>
      </summary>
      <div className="max-h-[220px] overflow-y-auto border-t border-[var(--surface-border)] px-3 pb-3">
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
    </details>
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
  const initialReferralCode = new URLSearchParams(window.location.search).get('invite') ?? '';
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(
    initialResetToken ? 'reset' : initialReferralCode ? 'register' : 'login',
  );
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [referralCode, setReferralCode] = useState(initialReferralCode.toUpperCase());
  const [referral, setReferral] = useState<ReferralSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviteExpanded, setInviteExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('verify');
    if (!token) return;
    void confirmEmailVerification(token)
      .then(async () => {
        onUser(await me());
        setNotice('邮箱验证成功');
        const url = new URL(window.location.href);
        url.searchParams.delete('verify');
        window.history.replaceState(null, '', url);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '验证失败'));
  }, [onUser]);

  useEffect(() => {
    if (!user?.emailVerified) return;
    void getReferralSummary()
      .then(setReferral)
      .catch(() => setReferral(null));
  }, [user?.emailVerified]);

  const visibleReferral = user?.emailVerified ? referral : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next =
        mode === 'login'
          ? await login(username.trim(), password)
          : await register({
              username: username.trim(),
              email: email.trim(),
              password,
              referralCode: referralCode.trim() || undefined,
            });
      onUser(next);
      if (mode === 'register' && referralCode) {
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState(null, '', url);
      }
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

        <div className="mt-5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-raised)] p-3">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-[var(--accent-soft)] p-2 text-[var(--accent)]">
              <Gift className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">邀请好友，获得 $5 Credit</div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-soft)]">
                好友通过你的链接注册并完成邮箱验证后，活动 Credit 自动到账；后续活动可使用。
              </p>
              {visibleReferral ? (
                <>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold tabular-nums">
                      ${(visibleReferral.balanceCents / 100).toFixed(2)} Credit
                    </span>
                    <Button variant="secondary" onClick={() => setInviteExpanded((open) => !open)}>
                      {inviteExpanded ? '收起' : '邀请好友'}
                    </Button>
                  </div>
                  {inviteExpanded ? (
                    <>
                      <div className="mt-3 flex min-w-0 gap-2">
                        <Input
                          readOnly
                          aria-label="邀请链接"
                          value={`${window.location.origin}/settings?invite=${visibleReferral.code}`}
                          className="min-w-0 flex-1 text-xs"
                        />
                        <Button
                          variant="secondary"
                          aria-label="复制邀请链接"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                `${window.location.origin}/settings?invite=${visibleReferral.code}`,
                              );
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1600);
                            } catch {
                              setError('复制失败，请手动选择邀请链接');
                            }
                          }}
                        >
                          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                        <ReferralMetric
                          label="已奖励"
                          value={String(visibleReferral.rewardedCount)}
                        />
                        <ReferralMetric
                          label="待验证"
                          value={String(visibleReferral.pendingCount)}
                        />
                      </div>
                    </>
                  ) : null}
                </>
              ) : (
                <p className="mt-2 text-xs text-[var(--text-faint)]">
                  {user.emailVerified ? '正在获取邀请链接…' : '完成邮箱验证后即可生成邀请链接。'}
                </p>
              )}
            </div>
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
        {registerMode && referralCode ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--text-soft)]">邀请码</span>
            <Input
              value={referralCode}
              onChange={(event) => setReferralCode(event.target.value.toUpperCase())}
              autoComplete="off"
              maxLength={32}
            />
            <span className="text-[11px] text-[var(--text-faint)]">
              完成邮箱验证后，邀请人将获得 $5 活动 Credit。
            </span>
          </label>
        ) : null}
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

function ReferralMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-xs)] bg-[var(--surface)] px-2 py-2">
      <div className="truncate text-sm font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-[10px] text-[var(--text-faint)]">{label}</div>
    </div>
  );
}
