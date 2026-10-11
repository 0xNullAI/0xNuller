import { CharacterPortrait, useCharacterAppearance } from '@0xnullai/auth/appearance-react';
import { usePublicMarketPortrait } from '@0xnullai/scenes/react';

/** The AI's avatar: the chosen portrait, else the character's icon. Header and messages share it. */
export function AssistantAvatar({
  name,
  icon,
  marketPortraitId,
  relationshipId,
  size = 'sm',
}: {
  name: string;
  icon?: string;
  marketPortraitId?: string;
  /** The private relationship whose saved avatar to show. */
  relationshipId?: string | null;
  size?: 'sm' | 'md';
}) {
  const box = size === 'md' ? 'h-10 w-10 text-lg' : 'h-7 w-7 text-sm';
  const appearance = useCharacterAppearance(relationshipId);
  const publicPortrait = usePublicMarketPortrait(marketPortraitId);
  if (appearance?.photoId || publicPortrait)
    return (
      <span title={name} className={`block shrink-0 ${box}`}>
        <CharacterPortrait
          photoId={appearance?.photoId ?? null}
          fallbackSource={publicPortrait}
          className={`${box} rounded-full`}
        />
      </span>
    );
  return (
    <span
      title={name}
      className={`flex shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)] ${box}`}
    >
      {icon ?? '✦'}
    </span>
  );
}
