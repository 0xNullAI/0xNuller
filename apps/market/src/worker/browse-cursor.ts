import type { ListParams } from './db';

/** The cursor is a position, not an authorization token. All rows are filtered again on read. */
export type BrowseCursor =
  | {
      version: 1;
      mode: 'stable';
      filter: string;
      maxPublishSeq: number;
      createdAt: number;
      id: string;
    }
  | { version: 1; mode: 'live'; filter: string; offset: number };

export function browseFilter(params: ListParams): string {
  return JSON.stringify([
    params.type ?? '',
    params.promptKind ?? '',
    params.character === true,
    params.modality ?? '',
    params.q ?? '',
    params.sort,
    params.limit,
  ]);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unbase64url(raw: string): Uint8Array {
  const padded = raw
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(raw.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`market-browse-v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function encodeBrowseCursor(cursor: BrowseCursor, secret: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await cursorKey(secret), new TextEncoder().encode(payload)),
  );
  return `${payload}.${base64url(signature)}`;
}

export async function decodeBrowseCursor(
  raw: string | null,
  filter: string,
  secret: string,
): Promise<BrowseCursor | null> {
  if (!raw || raw.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const [payload, signature] = raw.split('.');
    if (!payload || !signature) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await cursorKey(secret),
      unbase64url(signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(unbase64url(payload)),
    );
    if (!value || typeof value !== 'object') return null;
    const cursor = value as Partial<BrowseCursor>;
    if (cursor.version !== 1 || cursor.filter !== filter) return null;
    if (cursor.mode === 'stable') {
      return Number.isSafeInteger(cursor.maxPublishSeq) &&
        cursor.maxPublishSeq! >= 0 &&
        Number.isSafeInteger(cursor.createdAt) &&
        typeof cursor.id === 'string' &&
        cursor.id.length > 0 &&
        cursor.id.length <= 256
        ? (cursor as BrowseCursor)
        : null;
    }
    if (cursor.mode === 'live') {
      return Number.isSafeInteger(cursor.offset) &&
        cursor.offset! >= 0 &&
        cursor.offset! <= 1_000_000
        ? (cursor as BrowseCursor)
        : null;
    }
    return null;
  } catch {
    return null;
  }
}
