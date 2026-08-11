import { useEffect, useState } from 'react';
import { Avatar } from '@0xnullai/ui';
import { avatarSrc, getUser, requestProfileView, subscribeProfileChanges } from '@0xnullai/auth';

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
      void getUser(username).then((view) => {
        if (alive && view?.profile) setSrc(avatarSrc(view.profile.avatarUrl));
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
