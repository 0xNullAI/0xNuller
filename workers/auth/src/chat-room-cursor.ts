/** Keyset cursor for account-owned chat room bookmarks. Never carries an account ID or owner key. */
export interface ChatRoomCursor {
  updatedAt: number;
  code: string;
  accountHash: string;
}

export async function chatRoomAccountHash(accountId: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeChatRoomCursor(cursor: ChatRoomCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.code, cursor.accountHash]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeChatRoomCursor(value: string | null): ChatRoomCursor | null {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(
      atob(
        value
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(value.length / 4) * 4, '='),
      ),
    );
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [updatedAt, code, accountHash] = parsed;
    if (
      !Number.isSafeInteger(updatedAt) ||
      updatedAt < 0 ||
      typeof code !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(code) ||
      typeof accountHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(accountHash)
    )
      return null;
    return { updatedAt, code, accountHash };
  } catch {
    return null;
  }
}
