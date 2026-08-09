import { cn } from '../utils';

/**
 * Avatar. Generated deterministically from the account name — zero storage,
 * zero uploads.
 *
 * In an adult-oriented product, letting users upload avatars means dealing with
 * policy-violating images: a moderation pipeline, a reporting channel, appeals
 * for false positives. That is an entire product line, not a field. A remote
 * image URL is not a cheaper version of it either — it re-opens the same
 * moderation problem and adds one of its own, since every viewer's IP would be
 * handed to whatever host the URL points at. Generated avatars sidestep both;
 * the same account always gets the same pattern, which is distinctive enough.
 * The `avatar_url` column is reserved in auth's table, so enabling real uploads
 * later needs no schema change.
 *
 * It lives in the design system rather than in the shell because the shell, the
 * contacts dialog, the profile and Chat's member list all draw the same person
 * and must draw them identically — a second implementation would give one
 * account two faces.
 *
 * **Clicking through to a profile is opt-in and needs an account.** Most people
 * in a room have no account at all — anonymous use is a hard product constraint
 * — and an avatar that opens an empty page is worse than one that does nothing.
 * So the interactive form requires `username` *and* `onOpenProfile`; with
 * either missing this renders inert markup with no click target. The rule is
 * here, once, rather than at every call site that could forget it.
 */

/** FNV-1a: distributes well enough over short strings and depends on no library. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface AvatarProps {
  /** Shown as the initial and the label. A display name, a nickname, or null. */
  name: string | null;
  /**
   * The account handle, when there is an account behind this face.
   *
   * It is also what the pattern is generated from, so one account looks the
   * same everywhere even after they rename themselves.
   */
  username?: string | null;
  size?: number;
  /** Supplying this together with a username turns the avatar into a button. */
  onOpenProfile?: (username: string) => void;
  className?: string;
}

export function Avatar({ name, username, size = 28, onOpenProfile, className }: AvatarProps) {
  const handle = username?.trim() ? username.trim() : null;
  const label = name?.trim() ? name.trim() : handle;
  const interactive = handle !== null && onOpenProfile !== undefined;

  const shared = 'inline-flex shrink-0 items-center justify-center rounded-full';
  const style = { width: size, height: size, fontSize: size * 0.42 };

  if (!label) {
    return (
      <span
        className={cn(
          shared,
          'border border-[var(--surface-border)] bg-[var(--bg-soft)] text-[var(--text-faint)]',
          className,
        )}
        style={style}
        aria-hidden
      >
        ?
      </span>
    );
  }

  // Hue comes from the hash, saturation and lightness are fixed — this avoids
  // generating colors that collide with the background or the accent color, and
  // it is why the same two values work in both themes.
  const hue = hash(handle ?? label) % 360;
  // Spread rather than charAt: an emoji or a non-BMP character is two code
  // units, and slicing one off renders a replacement box.
  const face = [...label][0]?.toUpperCase() ?? '?';
  const paint = {
    ...style,
    background: `linear-gradient(135deg, hsl(${hue} 62% 48%), hsl(${(hue + 40) % 360} 62% 38%))`,
  };

  if (!interactive) {
    return (
      <span
        className={cn(shared, 'font-semibold text-white', className)}
        style={paint}
        aria-label={label}
        title={label}
      >
        {face}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        // Avatars sit inside rows that are themselves clickable — Chat's member
        // list opens that member's device controls, the contacts list opens a
        // detail. Without this the one click does both: the profile opens and
        // the surface underneath navigates somewhere the user never asked to
        // go, which in Chat's case is a panel that drives current.
        e.stopPropagation();
        onOpenProfile(handle);
      }}
      className={cn(
        shared,
        'font-semibold text-white transition-transform duration-[var(--dur-fast)] hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] active:scale-95',
        className,
      )}
      style={paint}
      aria-label={`查看 ${label} 的主页`}
      title={`查看 ${label} 的主页`}
    >
      {face}
    </button>
  );
}
