export interface ContentCursor {
  updatedAt: number;
  id: string;
}

export function encodeContentCursor(cursor: ContentCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeContentCursor(value: string | null): ContentCursor | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const updatedAt = Number(parsed[0]);
    const id = parsed[1];
    return Number.isSafeInteger(updatedAt) && updatedAt >= 0 && typeof id === 'string'
      ? { updatedAt, id }
      : null;
  } catch {
    return null;
  }
}
