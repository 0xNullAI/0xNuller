import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Flag,
  Link2,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  ShieldOff,
} from 'lucide-react';
import { Badge, Button, Overlay } from '@0xnullai/ui';
import { safeProfileLinks } from '@0xnullai/auth/profile-links';
import {
  beginFollowToggle,
  blockUser,
  canDirectMessage,
  followStateFrom,
  followUser,
  getUser,
  photoSrc,
  resolveProfileView,
  reportUser,
  saveProfile,
  uploadPhoto,
  settleFollowToggle,
  unfollowUser,
  type AuthUser,
  type FollowState,
  type ResolvedProfile,
  type UserProfile,
} from '@0xnullai/auth';
import { openDirectMessage } from '../dm-entry';
import { cleanProfile, ProfileForm } from './ProfileForm';
import { formatJoined, ProfileIdentity, ProfileMeta, ProfileSection, ProfileStats } from './frame';
import { ProfileWorks } from './ProfileWorks';

/**
 * Somebody's profile — including your own, which is the same surface in edit
 * mode rather than a separate form somewhere else.
 *
 * The account service requires login, hides blocked users and filters private
 * album photos. The UI displays only the returned profile projection.
 */

type Mode = 'view' | 'edit';

export function ProfileDialog({
  username,
  viewer,
  onClose,
  presentation = 'dialog',
  onOpenMarketItem,
  shellBack = false,
}: {
  username: string;
  viewer: AuthUser | null;
  onClose: () => void;
  presentation?: 'dialog' | 'page';
  onOpenMarketItem?: (id: string) => void;
  /** The shell top bar already shows back + title (phone), so the page omits its own row. */
  shellBack?: boolean;
}) {
  const [resolved, setResolved] = useState<ResolvedProfile | null>(null);
  const [follow, setFollow] = useState<FollowState | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [error, setError] = useState<string | null>(null);
  // The edit draft lives here rather than in the form, because the save button
  // is in this component's pinned action bar. A save button at the end of a
  // scrolling field list sits below the fold next to a pinned 「关闭」, which is
  // how you lose what you just typed.
  const [draft, setDraft] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const viewerId = viewer?.id ?? null;

  // Reset during render rather than from an effect when the subject changes.
  // Clearing in the effect would paint one frame of the previous person's
  // profile under the new person's name — on a surface where the whole point
  // is that you are looking at a specific someone. The same idiom is used for
  // the shell's drawer; see Shell.tsx.
  const subject = `${username}\0${viewerId ?? ''}`;
  const [lastSubject, setLastSubject] = useState(subject);
  if (lastSubject !== subject) {
    setLastSubject(subject);
    setResolved(null);
    setFollow(null);
    setMode('view');
    setError(null);
    setDraft(null);
  }

  useEffect(() => {
    let alive = true;
    // getUser never throws: a missing account, a block and an unreachable
    // service all arrive as null, and all three have to read the same way or
    // the difference between them becomes detectable from the outside.
    void getUser(username).then((view) => {
      if (!alive) return;
      const next = resolveProfileView(view, viewerId);
      setResolved(next);
      setFollow(followStateFrom(next));
    });
    return () => {
      alive = false;
    };
  }, [username, viewerId]);

  const toggleFollow = useCallback(async () => {
    if (!follow || !resolved || resolved.state === 'unavailable') return;
    const targetId = resolved.user.id;
    const wasFollowing = follow.following;
    // Optimistic: the button and the count move now, and go back together if
    // the request fails. Both live in one reducer so they cannot disagree.
    const optimistic = beginFollowToggle(follow);
    if (optimistic === follow) return; // already in flight
    setFollow(optimistic);
    setError(null);

    const result = wasFollowing ? await unfollowUser(targetId) : await followUser(targetId);
    setFollow((current) => (current ? settleFollowToggle(current, result.ok) : current));
    if (!result.ok) setError(result.error ?? '操作失败');
  }, [follow, resolved]);

  const startEditing = useCallback(() => {
    if (resolved?.state !== 'visible') return;
    setDraft(resolved.profile);
    setError(null);
    setMode('edit');
  }, [resolved]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const cleaned = cleanProfile(draft);
    try {
      await saveProfile(cleaned);
      setResolved((prev) => (prev?.state === 'visible' ? { ...prev, profile: cleaned } : prev));
      setMode('view');
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const changeAvatar = useCallback(async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      const photo = await uploadPhoto(file, { visibility: 'public', purpose: 'avatar' });
      setDraft((current) => (current ? { ...current, avatarUrl: photo.url } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  }, []);

  const content = (
    <div
      role={presentation === 'dialog' ? 'dialog' : 'region'}
      aria-modal={presentation === 'dialog' || undefined}
      aria-label="用户主页"
      className={
        presentation === 'dialog'
          ? 'flex max-h-[min(680px,calc(100dvh-2rem))] w-[min(480px,calc(100vw-2rem))] flex-col rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)]'
          : 'ui-push-in mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col bg-[var(--bg)]'
      }
    >
      {presentation === 'page' && !shellBack ? (
        <div className="shrink-0 px-2 py-1 sm:px-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft className="h-4 w-4" /> 返回
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:p-6">
        {resolved === null ? (
          <p
            role="status"
            aria-live="polite"
            className="py-10 text-center text-sm text-[var(--text-faint)]"
          >
            加载中…
          </p>
        ) : resolved.state === 'unavailable' ? (
          // One wording for "no such account", "one of you blocked the
          // other" and "the service is unreachable". The server answers all
          // three identically so a block cannot be found by probing, and
          // saying more here would undo that.
          <p className="py-10 text-center text-sm text-[var(--text-faint)]">未找到用户</p>
        ) : mode === 'edit' && draft ? (
          <div className="flex flex-col gap-6">
            <ProfileIdentity
              displayName={resolved.user.displayName}
              username={resolved.user.username}
              avatarUrl={draft.avatarUrl}
              onAvatarChange={(file) => void changeAvatar(file)}
              avatarBusy={uploadingAvatar}
            />
            <ProfileForm draft={draft} onChange={setDraft} />
          </div>
        ) : (
          <ProfileBody
            resolved={resolved}
            follow={follow}
            viewerId={viewerId}
            onOpenMarketItem={onOpenMarketItem}
            actions={
              <ProfileActions
                resolved={resolved}
                follow={follow}
                error={error}
                onEdit={startEditing}
                onToggleFollow={() => void toggleFollow()}
                onClose={onClose}
              />
            }
          />
        )}
      </div>

      {mode === 'edit' && draft ? (
        <div className="flex flex-col gap-2 border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] text-[var(--text-faint)]">
              登录用户可见 · 相册照片可单独设置范围
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={saving} onClick={() => setMode('view')}>
                取消
              </Button>
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      ) : resolved && resolved.state !== 'unavailable' ? null : (
        <div className="flex justify-end border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </div>
      )}
    </div>
  );
  return presentation === 'page' ? content : <Overlay onDismiss={onClose}>{content}</Overlay>;
}

/** Everything above the action bar. */
function ProfileBody({
  resolved,
  follow,
  viewerId,
  onOpenMarketItem,
  actions,
}: {
  resolved: Exclude<ResolvedProfile, { state: 'unavailable' }>;
  follow: FollowState | null;
  viewerId: string | null;
  onOpenMarketItem?: (id: string) => void;
  actions: ReactNode;
}) {
  const mutual = follow?.following === true && follow.followedBy === true;
  const badge = mutual ? (
    <Badge variant="accent">互相关注</Badge>
  ) : resolved.relationship === 'followsYou' ? (
    <Badge>关注了你</Badge>
  ) : null;

  const joined = formatJoined(resolved.createdAt);
  const links = safeProfileLinks(resolved.profile.links);

  return (
    <div className="flex flex-col gap-6">
      {/* One header: who, what they say about themselves, the counts, then what you can do. */}
      <header className="flex flex-col gap-3">
        <ProfileIdentity
          displayName={resolved.user.displayName}
          username={resolved.user.username}
          avatarUrl={resolved.profile.avatarUrl}
          badge={badge}
        />
        {resolved.profile.bio ? (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--text)]">
            {resolved.profile.bio}
          </p>
        ) : resolved.relationship === 'self' && !resolved.profile.location ? (
          // Your own untouched profile, which is otherwise three numbers and a
          // date. Worded as an invitation and not as a task: an account that
          // stays empty is a finished account, and a nag bar would say the
          // opposite of what this product promises.
          <p className="text-sm leading-relaxed text-[var(--text-faint)]">
            暂无资料，所有内容均为选填
          </p>
        ) : null}
        <ProfileStats
          followers={follow?.followerCount ?? resolved.followers}
          following={resolved.following}
        />
        {actions}
      </header>

      {resolved.profile.interests.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {resolved.profile.interests.map((interest) => (
            <span
              key={interest}
              className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs text-[var(--accent)]"
            >
              {interest}
            </span>
          ))}
        </div>
      ) : null}

      {(resolved.profile.location || joined) && (
        <div className="flex flex-col gap-1.5">
          {resolved.profile.location && (
            <ProfileMeta icon={<MapPin className="h-4 w-4" />}>
              {resolved.profile.location}
            </ProfileMeta>
          )}
          {joined && (
            <ProfileMeta icon={<CalendarDays className="h-4 w-4" />}>{joined}</ProfileMeta>
          )}
        </div>
      )}

      {links.length > 0 && (
        <ProfileSection title="链接">
          <div className="flex flex-col gap-1.5">
            {links.map((link) => (
              <ProfileMeta key={link} icon={<Link2 className="h-4 w-4" />}>
                <a
                  href={link}
                  // noreferrer as well as noopener: the destination should not
                  // be told which profile sent the visitor.
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-[var(--accent)] underline underline-offset-2"
                >
                  {link}
                </a>
              </ProfileMeta>
            ))}
          </div>
        </ProfileSection>
      )}

      {resolved.photos.length > 0 && (
        <ProfileSection title="相册">
          <div className="grid grid-cols-3 gap-2">
            {resolved.photos.map((photo) => (
              <img
                key={photo.id}
                src={photoSrc(photo)}
                alt={photo.caption ?? '相册照片'}
                loading="lazy"
                className="aspect-square w-full rounded-[var(--radius-xs)] border border-[var(--surface-border)] object-cover"
              />
            ))}
          </div>
        </ProfileSection>
      )}

      {viewerId && (
        <ProfileWorks creatorId={resolved.user.id} viewerId={viewerId} onOpen={onOpenMarketItem} />
      )}
    </div>
  );
}

/**
 * The action bar. Follow, direct message, and — on your own profile — edit.
 *
 * Direct message is shown rather than hidden when it is unavailable, and says
 * why. Mutual follow being the gate is something this product wants people to
 * understand; a button that only materialises once you already qualify teaches
 * nobody what the rule was.
 */
function ProfileActions({
  resolved,
  follow,
  error,
  onEdit,
  onToggleFollow,
  onClose,
}: {
  resolved: Exclude<ResolvedProfile, { state: 'unavailable' }>;
  follow: FollowState | null;
  error: string | null;
  onEdit: () => void;
  onToggleFollow: () => void;
  onClose: () => void;
}) {
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<
    'spam' | 'harassment' | 'impersonation' | 'unsafe' | 'other'
  >('spam');
  const [reportDetails, setReportDetails] = useState('');
  const [safetyBusy, setSafetyBusy] = useState(false);
  const [safetyNotice, setSafetyNotice] = useState<string | null>(null);
  const { relationship } = resolved;

  if (relationship === 'self') {
    return (
      <div className="flex flex-col gap-2">
        {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" className="ui-press" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            编辑资料
          </Button>
        </div>
      </div>
    );
  }

  const following = follow?.following ?? false;
  const pending = follow?.pending != null;
  // Mutual is not recomputed here. It decides two different things — the badge
  // by the name and whether direct messages are open — and canDirectMessage
  // already adds the in-flight condition that the badge must not have.
  const dmAllowed = follow ? canDirectMessage(follow, relationship) : false;

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      {safetyNotice && <p className="text-xs text-[var(--success)]">{safetyNotice}</p>}
      <div className="flex items-center gap-2">
        {/* The button says what your side of the relationship is, never
            「互相关注」 — that is the badge's job up by the name, and saying it
            twice makes the button look like a label rather than a control. */}
        <Button
          size="sm"
          variant={following ? 'secondary' : 'default'}
          disabled={pending}
          onClick={onToggleFollow}
          className="ui-press min-w-[88px]"
        >
          {following ? '已关注' : relationship === 'followsYou' ? '回关' : '关注'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="ui-press min-w-[88px]"
          disabled={!dmAllowed}
          title={!dmAllowed ? '互相关注后可私聊' : undefined}
          onClick={() => {
            openDirectMessage(resolved.user.id);
            onClose();
          }}
        >
          <MessageSquare className="h-4 w-4" />
          私聊
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="ui-press"
          aria-label="更多用户操作"
          onClick={() => {
            setSafetyOpen((open) => !open);
            setConfirmBlock(false);
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>
      {!dmAllowed && <p className="text-xs text-[var(--text-faint)]">互相关注后可私聊</p>}
      {safetyOpen ? (
        <div className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-raised)] p-2">
          {reportOpen ? (
            <div className="space-y-2 p-1">
              <label className="block text-xs font-medium">举报原因</label>
              <select
                value={reportReason}
                onChange={(event) => setReportReason(event.target.value as typeof reportReason)}
                className="h-9 w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--surface)] px-2 text-sm"
              >
                <option value="spam">垃圾或骚扰信息</option>
                <option value="harassment">骚扰或威胁</option>
                <option value="impersonation">冒充他人</option>
                <option value="unsafe">不安全行为</option>
                <option value="other">其他</option>
              </select>
              <textarea
                value={reportDetails}
                maxLength={500}
                rows={3}
                placeholder="可选：补充具体情况"
                onChange={(event) => setReportDetails(event.target.value)}
                className="w-full resize-none rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--surface)] p-2 text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setReportOpen(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={safetyBusy}
                  onClick={async () => {
                    setSafetyBusy(true);
                    const result = await reportUser(resolved.user.id, reportReason, reportDetails);
                    setSafetyBusy(false);
                    if (result.ok) {
                      setReportOpen(false);
                      setSafetyOpen(false);
                      setSafetyNotice('举报已提交');
                    }
                  }}
                >
                  提交举报
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReportOpen(true)}>
                <Flag className="h-4 w-4" /> 举报
              </Button>
              {confirmBlock ? (
                <>
                  <span className="flex-1 text-xs text-[var(--text-soft)]">
                    屏蔽会解除双方关注并结束私聊。
                  </span>
                  <Button
                    size="sm"
                    disabled={safetyBusy}
                    onClick={async () => {
                      setSafetyBusy(true);
                      const result = await blockUser(resolved.user.id);
                      setSafetyBusy(false);
                      if (result.ok) onClose();
                    }}
                  >
                    确认屏蔽
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmBlock(true)}>
                  <ShieldOff className="h-4 w-4" /> 屏蔽
                </Button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
