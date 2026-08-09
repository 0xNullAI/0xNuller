import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Link2, Lock, MapPin, MessageSquare, Pencil } from 'lucide-react';
import { Badge, Button, Overlay } from '@0xnullai/ui';
import {
  beginFollowToggle,
  canDirectMessage,
  followStateFrom,
  followUser,
  getUser,
  photoSrc,
  resolveProfileView,
  saveProfile,
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

/**
 * Somebody's profile — including your own, which is the same surface in edit
 * mode rather than a separate form somewhere else.
 *
 * **The UI never decides who may see what.** The account service returns
 * exactly what the viewer is entitled to: a private profile arrives with no
 * body, no counts and no join date, and a block arrives as "no such user".
 * Everything here is derived from that answer by `resolveProfileView`, so
 * there is no branch that could render a value the server withheld — the
 * hidden case simply has no fields on it.
 *
 * Signed out is a first-class state, not a degraded one. Anonymous use is a
 * hard product constraint: a public profile is readable with no account, and
 * the actions that do need one say so instead of failing.
 */

type Mode = 'view' | 'edit';

export function ProfileDialog({
  username,
  viewer,
  onClose,
}: {
  username: string;
  viewer: AuthUser | null;
  onClose: () => void;
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

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="用户主页"
        className="flex max-h-[min(680px,calc(100dvh-2rem))] w-[min(480px,calc(100vw-2rem))] flex-col rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow-panel)]"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
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
            <p className="py-10 text-center text-sm text-[var(--text-faint)]">没有找到这个用户。</p>
          ) : mode === 'edit' && draft ? (
            <div className="flex flex-col gap-6">
              <ProfileIdentity
                displayName={resolved.user.displayName}
                username={resolved.user.username}
              />
              <ProfileForm draft={draft} onChange={setDraft} />
            </div>
          ) : (
            <ProfileBody resolved={resolved} follow={follow} />
          )}
        </div>

        {mode === 'edit' && draft ? (
          <div className="flex flex-col gap-2 border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
            {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] text-[var(--text-faint)]">
                {draft.visibility === 'public'
                  ? '保存后所有人都能看到。'
                  : '保存后只有你自己能看到。'}
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
        ) : resolved && resolved.state !== 'unavailable' ? (
          <ProfileActions
            resolved={resolved}
            follow={follow}
            error={error}
            onEdit={startEditing}
            onToggleFollow={() => void toggleFollow()}
            onClose={onClose}
          />
        ) : (
          <div className="flex justify-end border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
          </div>
        )}
      </div>
    </Overlay>
  );
}

/** Everything above the action bar, in both the visible and the hidden case. */
function ProfileBody({
  resolved,
  follow,
}: {
  resolved: Exclude<ResolvedProfile, { state: 'unavailable' }>;
  follow: FollowState | null;
}) {
  const mutual = follow?.following === true && follow.followedBy === true;
  const badge = mutual ? (
    <Badge variant="accent">互相关注</Badge>
  ) : resolved.relationship === 'followsYou' ? (
    <Badge>关注了你</Badge>
  ) : null;

  if (resolved.state === 'hidden') {
    return (
      <div className="flex flex-col gap-6">
        <ProfileIdentity
          displayName={resolved.user.displayName}
          username={resolved.user.username}
          badge={badge}
        />
        {/* No counts, no join date, no placeholder rows. A greyed-out skeleton
            of what is being withheld still tells the viewer this account is
            active and how popular it is, which is what private was for. */}
        <div className="flex items-center gap-2.5 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-4 py-3">
          <Lock className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
          <p className="text-sm text-[var(--text-soft)]">
            这个人的主页设为了仅自己可见。
            <span className="text-[var(--text-faint)]">关注也不会解锁。</span>
          </p>
        </div>
      </div>
    );
  }

  const joined = formatJoined(resolved.createdAt);
  const links = resolved.profile.links.filter((l) => l.trim());

  return (
    <div className="flex flex-col gap-6">
      <ProfileIdentity
        displayName={resolved.user.displayName}
        username={resolved.user.username}
        badge={badge}
      />

      <ProfileStats
        followers={follow?.followerCount ?? resolved.followers}
        following={resolved.following}
      />

      {resolved.profile.bio ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
          {resolved.profile.bio}
        </p>
      ) : resolved.relationship === 'self' && !resolved.profile.location ? (
        // Your own untouched profile, which is otherwise three numbers and a
        // date. Worded as an invitation and not as a task: an account that
        // stays empty is a finished account, and a nag bar would say the
        // opposite of what this product promises.
        <p className="text-sm leading-relaxed text-[var(--text-faint)]">
          还没有填任何资料。全部选填，不填也完全能用。
        </p>
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

      {/* No R2 bucket is bound yet, so there is no upload path and this list is
          empty in practice. It renders from the same gated response as the rest
          of the profile, so it will be correct rather than new the day uploads
          land. */}
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
  const { relationship } = resolved;

  if (relationship === 'self') {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
        <span className="text-xs text-[var(--text-faint)]">
          {resolved.state === 'visible' && resolved.profile.visibility === 'public'
            ? '这是别人看到的样子。'
            : '目前只有你自己能看到这些。'}
        </span>
        <Button onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          编辑资料
        </Button>
      </div>
    );
  }

  if (relationship === 'anonymous') {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
        {/* Signed out is not broken. The profile above is fully readable; only
            the actions that need an identity are unavailable, and they say so
            rather than being offered and then failing. */}
        <span className="text-xs text-[var(--text-faint)]">登录后可以关注和私聊。</span>
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
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
    <div className="flex flex-col gap-2 border-t border-[var(--surface-border)] px-5 py-4 sm:px-6">
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      <div className="flex items-center gap-2">
        {/* The button says what your side of the relationship is, never
            「互相关注」 — that is the badge's job up by the name, and saying it
            twice makes the button look like a label rather than a control. */}
        <Button
          variant={following ? 'secondary' : 'default'}
          disabled={pending}
          onClick={onToggleFollow}
          className="flex-1"
        >
          {following ? '已关注' : relationship === 'followsYou' ? '回关' : '关注'}
        </Button>
        <Button
          variant="secondary"
          className="flex-1"
          disabled={!dmAllowed}
          title={!dmAllowed ? '互相关注后可以私聊' : undefined}
          onClick={() => {
            openDirectMessage(resolved.user.id);
            onClose();
          }}
        >
          <MessageSquare className="h-4 w-4" />
          私聊
        </Button>
      </div>
      {!dmAllowed && <p className="text-[10px] text-[var(--text-faint)]">互相关注之后才能私聊。</p>}
    </div>
  );
}
