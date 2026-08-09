/**
 * Avatar. Generated deterministically from the username — zero storage, zero uploads.
 *
 * In an adult-oriented product, letting users upload avatars means dealing with
 * policy-violating images: a moderation pipeline, a reporting channel, appeals for
 * false positives. That is an entire product line, not a field. Generated avatars
 * sidestep the whole thing; the same username always gets the same pattern, which
 * is distinctive enough. The `avatar_url` column is reserved in auth's table, so
 * actually enabling uploads later won't need a schema change.
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

export function Avatar({ name, size = 28 }: { name: string | null; size?: number }) {
  if (!name) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-soft)] text-[var(--text-faint)]"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden
      >
        ?
      </span>
    );
  }

  const h = hash(name);
  // Hue comes from the hash, saturation and lightness are fixed — this avoids
  // generating colors that collide with the background or the accent color.
  const hue = h % 360;
  const initial = [...name][0]?.toUpperCase() ?? '?';

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 62% 48%), hsl(${(hue + 40) % 360} 62% 38%))`,
      }}
      aria-label={name}
      title={name}
    >
      {initial}
    </span>
  );
}
