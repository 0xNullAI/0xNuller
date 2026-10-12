import { BillingOrdersPanel } from './BillingOrdersPanel';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';
import { RegistrationConsent } from '../legal/RegistrationConsent';
import { publicPageUrl } from '@0xnullai/settings';
import { CreditActivityPanel } from './CreditActivityPanel';
import { useEffect, useRef, useState } from 'react';
import { Check, Coins, Copy, Gift, Laptop, LogOut, Mail, Share2, UserX } from 'lucide-react';
import { SettingsGroup, SettingsRow } from './settings-list';
import { Avatar, Button, Input } from '@0xnullai/ui';
import {
  avatarSrc,
  deleteAccount,
  getCreditBalance,
  getReferralSummary,
  listAccountSessions,
  login,
  logout,
  me,
  confirmEmailVerification,
  register,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  requestProfileView,
  revokeAccountSession,
  revokeOtherAccountSessions,
  type AccountSession,
  type AuthUser,
  type CreditBalance,
  type ReferralSummary,
} from '@0xnullai/auth';

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
  const [creditState, setCreditState] = useState<{
    accountId: string;
    balance: CreditBalance;
  } | null>(null);
  const [creditExpanded, setCreditExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviteExpanded, setInviteExpanded] = useState(false);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verifyToken = useRef(new URLSearchParams(window.location.search).get('verify'));
  useEffect(() => {
    const token = verifyToken.current;
    if (!token) return;
    // A verification link is single-use. Consume it before the request so a
    // re-run of this effect (a new `onUser`) cannot resubmit a spent token and
    // show "link expired" next to the success notice.
    verifyToken.current = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('verify');
    window.history.replaceState(null, '', url);
    void confirmEmailVerification(token)
      .then(async () => {
        onUser(await me());
        setNotice('邮箱验证成功');
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '验证失败'));
  }, [onUser]);

  useEffect(() => {
    if (!user?.emailVerified) return;
    void getReferralSummary()
      .then(setReferral)
      .catch(() => setReferral(null));
  }, [user?.emailVerified]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    const refresh = () =>
      void getCreditBalance()
        .then((balance) => {
          if (active) setCreditState({ accountId: user.id, balance });
        })
        .catch(() => {
          if (active) setCreditState(null);
        });
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [user]);
  const credit = creditState && creditState.accountId === user?.id ? creditState.balance : null;

  const visibleReferral = user?.emailVerified ? referral : null;

  useEffect(() => {
    if (!user || !sessionsExpanded) return;
    void listAccountSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [user, sessionsExpanded]);

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
              acceptedTerms: LEGAL_TERMS_VERSION,
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
    const inviteLink = visibleReferral
      ? publicPageUrl('/settings', { invite: visibleReferral.code })
      : null;
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3 px-1">
          <Avatar
            name={user.displayName}
            username={user.username}
            src={avatarSrc(user.avatarUrl)}
            size={52}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-[17px] font-semibold">{user.displayName}</div>
              {user.role === 'admin' ? (
                <span className="shrink-0 rounded-full border border-[var(--accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                  管理员
                </span>
              ) : null}
            </div>
            <div className="truncate text-[13px] text-[var(--text-faint)]">@{user.username}</div>
          </div>
          <button
            type="button"
            className="ui-press shrink-0 rounded-full px-3 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            onClick={() => {
              onDone();
              requestProfileView(user.username);
            }}
          >
            我的主页
          </button>
        </div>

        {notice && <p className="px-4 text-xs text-[var(--success)]">{notice}</p>}
        {error && <p className="px-4 text-xs text-[var(--danger)]">{error}</p>}

        <SettingsGroup>
          {user.email ? (
            <SettingsRow
              icon={Mail}
              label={user.email}
              detail={user.emailVerified ? '已验证' : '尚未验证'}
              chevron={false}
            >
              {!user.emailVerified && user.emailAvailable ? (
                <Button
                  size="sm"
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
            </SettingsRow>
          ) : null}
          <SettingsRow
            icon={Coins}
            label="Credit"
            value={credit ? credit.available : '—'}
            onClick={() => setCreditExpanded((open) => !open)}
          />
          {creditExpanded ? (
            <div className="border-b border-[var(--surface-border)] px-4 pb-3 pl-12">
              <p className="text-xs leading-relaxed text-[var(--text-soft)]">
                充值内测中，可以联系管理员 QQ 询问。
              </p>
              {credit?.reserved ? (
                <p className="mt-2 text-xs text-[var(--text-faint)]">
                  正在使用：{credit.reserved} Credit
                </p>
              ) : null}
              <div className="mt-3">
                <BillingOrdersPanel accountId={user.id} />
                <CreditActivityPanel accountId={user.id} />
              </div>
            </div>
          ) : null}
          <SettingsRow
            icon={Gift}
            label="邀请好友"
            detail={
              visibleReferral
                ? '好友验证邮箱后，你得 500 Credit'
                : user.emailVerified
                  ? '正在获取邀请链接…'
                  : '验证邮箱后可邀请'
            }
            onClick={visibleReferral ? () => setInviteExpanded((open) => !open) : undefined}
          />
          {visibleReferral && inviteLink && inviteExpanded ? (
            <div className="border-b border-[var(--surface-border)] px-4 pb-3 pl-12">
              <div className="flex min-w-0 gap-2">
                <div
                  aria-label="邀请码"
                  className="min-w-0 flex-1 truncate rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--surface)] px-3 py-2 font-mono text-xs"
                >
                  {visibleReferral.code}
                </div>
                <Button
                  variant="secondary"
                  aria-label="复制邀请链接"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inviteLink);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1600);
                    } catch {
                      setError('复制失败，请手动选择邀请链接');
                    }
                  }}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                {typeof navigator.share === 'function' ? (
                  <Button
                    variant="secondary"
                    aria-label="分享邀请链接"
                    onClick={() =>
                      void navigator.share({
                        title: '加入猫愿',
                        text: '使用我的邀请链接注册猫愿',
                        url: inviteLink,
                      })
                    }
                  >
                    <Share2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 text-xs tabular-nums text-[var(--text-faint)]">
                已奖励 {visibleReferral.rewardedCount} · 待验证 {visibleReferral.pendingCount}
              </p>
              {visibleReferral.activity.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {visibleReferral.activity.slice(0, 5).map((item, index) => (
                    <div
                      key={`${item.createdAt}-${index}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="text-[var(--text-soft)]">
                        {new Date(item.createdAt).toLocaleDateString()}
                      </span>
                      <span
                        className={
                          item.status === 'rewarded'
                            ? 'text-[var(--success)]'
                            : 'text-[var(--text-faint)]'
                        }
                      >
                        {item.status === 'rewarded'
                          ? `+${item.rewardCredits} Credit`
                          : item.status === 'pending'
                            ? '等待邮箱验证'
                            : '未通过'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <SettingsRow
            icon={Laptop}
            label="登录设备"
            onClick={() => setSessionsExpanded((open) => !open)}
          />
          {sessionsExpanded ? (
            <div className="px-2 pb-2 pl-10">
              {sessions === null ? (
                <p className="px-2 py-3 text-xs text-[var(--text-faint)]">加载中…</p>
              ) : sessions.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--text-faint)]">暂时无法获取登录设备</p>
              ) : (
                <>
                  {sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onRevoke={async () => {
                        await revokeAccountSession(session.id);
                        setSessions(
                          (current) => current?.filter((item) => item.id !== session.id) ?? [],
                        );
                        if (session.current) {
                          onUser(null);
                          onDone();
                        }
                      }}
                    />
                  ))}
                  {sessions.some((session) => !session.current) ? (
                    <button
                      type="button"
                      className="mt-2 px-2 text-xs text-[var(--danger)] underline underline-offset-2"
                      onClick={async () => {
                        await revokeOtherAccountSessions();
                        setSessions((current) => current?.filter((item) => item.current) ?? []);
                      }}
                    >
                      退出其他所有设备
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            icon={LogOut}
            label="退出登录"
            chevron={false}
            onClick={async () => {
              await logout().catch(() => undefined);
              onUser(null);
              onDone();
            }}
          />
          <SettingsRow
            icon={UserX}
            label="注销账户"
            tone="danger"
            chevron={false}
            onClick={async () => {
              if (!window.confirm('永久删除账户和同步数据？')) return;
              await deleteAccount().catch(() => undefined);
              onUser(null);
              onDone();
            }}
          />
        </SettingsGroup>
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
              完成邮箱验证后，邀请人将获得 500 Credit。
            </span>
          </label>
        ) : null}
      </div>

      {/* The 用户协议 carries the full safety notice, so sign-up shows only the consent. */}
      {registerMode && <RegistrationConsent checked={agreed} onCheckedChange={setAgreed} />}

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

function SessionRow({
  session,
  onRevoke,
}: {
  session: AccountSession;
  onRevoke: () => Promise<void>;
}) {
  const device = session.userAgent?.includes('Android')
    ? 'Android'
    : session.userAgent?.includes('Windows')
      ? 'Windows'
      : session.userAgent?.includes('Macintosh')
        ? 'macOS'
        : '浏览器或客户端';
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-xs)] px-2 py-2 hover:bg-[var(--bg-soft)]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">
          {device}
          {session.current ? ' · 当前设备' : ''}
        </div>
        <div className="truncate text-[10px] text-[var(--text-faint)]">
          {new Date(session.createdAt).toLocaleDateString()} 登录
        </div>
      </div>
      <button
        type="button"
        className="text-xs text-[var(--danger)]"
        onClick={() => void onRevoke()}
      >
        退出
      </button>
    </div>
  );
}
