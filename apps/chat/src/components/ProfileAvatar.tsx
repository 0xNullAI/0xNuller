import { useEffect, useState } from 'react';
import { Avatar } from '@0xnullai/ui';
import { avatarSrc, getUser, requestProfileView, subscribeProfileChanges } from '@0xnullai/auth';

/**
 * One lookup per account, shared by every bubble: a conversation renders the same few senders
 * dozens of times. Entries expire, and a profile change anywhere clears them.
 */
const AVATAR_TTL_MS = 5 * 60_000;
const avatars = new Map<string, { at: number; src: Promise<string | null> }>();
let invalidationHooked = false;

function avatarFor(username: string): Promise<string | null> {
  if (!invalidationHooked) {
    invalidationHooked = true;
    subscribeProfileChanges(() => avatars.clear());
  }
  const cached = avatars.get(username);
  if (cached && Date.now() - cached.at < AVATAR_TTL_MS) return cached.src;
  const src = getUser(username)
    .then((view) => (view?.profile ? avatarSrc(view.profile.avatarUrl) : null))
    .catch(() => {
      avatars.delete(username);
      return null;
    });
  avatars.set(username, { at: Date.now(), src });
  return src;
}

export function ProfileAvatar({
  name,
  username,
  size,
  interactive = true,
}: {
  name: string;
  username?: string | null;
  size: number;
  interactive?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!username) return;
      void avatarFor(username).then((next) => {
        if (alive && next) setSrc(next);
      });
    };
    refresh();
    const unsubscribe = subscribeProfileChanges(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [username]);

  return (
    <Avatar
      name={name}
      username={username}
      src={src}
      size={size}
      onOpenProfile={interactive ? requestProfileView : undefined}
    />
  );
}
