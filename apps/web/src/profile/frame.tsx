import type { ReactNode } from 'react';
import { Avatar } from '@0xnullai/ui';

/**
 * The pieces the public profile and the self-edit view are both built from.
 *
 * They exist as one set rather than two because the two views are the same
 * page in two modes — you edit the thing you are looking at, in place. When
 * the editor was a separate stack of labelled fields, saving felt like
 * submitting a form to somewhere else and there was no moment where you saw
 * what you had actually published.
 */

/** The identity block. Never editable: a display name is set at registration, not here. */
export function ProfileIdentity({
  displayName,
  username,
  badge,
}: {
  displayName: string;
  username: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      <Avatar name={displayName} username={username} size={64} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold tracking-tight">{displayName}</div>
        <div className="truncate text-sm text-[var(--text-faint)]">@{username}</div>
        {badge ? <div className="mt-1.5 flex flex-wrap gap-1.5">{badge}</div> : null}
      </div>
    </div>
  );
}

/**
 * Follower and following counts.
 *
 * Rendered only where the caller has real numbers. There is deliberately no
 * "unknown" rendering: a profile the viewer may not see must show no count at
 * all, and a dash in the same slot still tells them the account is there and
 * has a follower graph.
 */
export function ProfileStats({ followers, following }: { followers: number; following: number }) {
  return (
    <div className="flex gap-6">
      {[
        { label: '关注', value: following },
        { label: '粉丝', value: followers },
      ].map((stat) => (
        <div key={stat.label} className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold tabular-nums">{stat.value}</span>
          <span className="text-xs text-[var(--text-soft)]">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A titled block. One rhythm for both modes, so a field sits exactly where its value did. */
export function ProfileSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-[var(--text-soft)]">{title}</h3>
        {hint ? <span className="text-[10px] text-[var(--text-faint)]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** An icon + value line: region, join date, a link. */
export function ProfileMeta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--text-soft)]">
      <span className="shrink-0 text-[var(--text-faint)]">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/**
 * Month precision, never the day.
 *
 * A join date to the day is one more correlatable fact about an account whose
 * owner may be relying on not being correlatable. The month answers what
 * anybody actually wants to know — whether this account is new.
 */
export function formatJoined(epochMs: number | null): string | null {
  if (epochMs == null || !Number.isFinite(epochMs)) return null;
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月加入`;
}
