/** Only ordinary web URLs may become clickable links on a public profile. */
export function normalizeProfileLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Defensively filter legacy stored rows and independently supplied profile views. */
export function safeProfileLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((item) => {
    const link = normalizeProfileLink(item);
    return link ? [link] : [];
  });
}
