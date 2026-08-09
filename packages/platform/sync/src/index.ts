import { apiBaseUrl } from '@0xnullai/settings';

/**
 * Account sync.
 *
 * The account dialog has always said an account is 「用于同步波形库、场景与
 * 市场归属」. This is that, on the client side.
 *
 * Two rules shape the whole module:
 *
 * 1. **An account is never a prerequisite.** Anonymous use is a hard product
 *    constraint, so every function here degrades to a no-op when signed out
 *    or when the service is unreachable. Nothing may throw into a caller that
 *    was just trying to save a waveform.
 *
 * 2. **API keys are never uploaded.** Syncing them would make 0xNullAI the
 *    custodian of somebody else's third-party credential, which the user
 *    never agreed to. Provider, model and base URL sync; the key stays on the
 *    device. `stripSecrets` is the one place that decision is enforced, and
 *    it is enforced here rather than on the server because the server cannot
 *    tell what is inside an opaque payload.
 */

export type SyncNamespace = 'llm' | 'device-safety' | 'proxy' | 'ui';
export type ContentKind = 'waveform' | 'scene';

export interface SyncedContent {
  id: string;
  kind: ContentKind;
  name: string;
  payload: unknown;
  updatedAt: number;
  deleted: boolean;
}

const TOKEN_KEY = '0xnullai.auth-token';

function authHeaders(): Record<string, string> {
  // Private browsing can reject the read; signed-out is the right reading of
  // that, not a crash.
  const token = (() => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  })();
  return {
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Never throws. A sync failure must not surface where a local save is happening. */
async function call<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      credentials: 'include',
      headers: { ...authHeaders(), ...init?.headers },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Remove anything that must not leave the device.
 *
 * Currently the LLM API key. Written as a deny-list over known secret field
 * names rather than an allow-list of safe ones, because a new *safe* field
 * appearing and silently not syncing is a much smaller failure than a new
 * *secret* field appearing and silently syncing.
 */
export function stripSecrets(namespace: SyncNamespace, payload: unknown): unknown {
  if (namespace !== 'llm' || !payload || typeof payload !== 'object') return payload;
  const { apiKey: _apiKey, ...rest } = payload as Record<string, unknown>;
  return rest;
}

export interface RemoteSettings<T = unknown> {
  payload: T | null;
  version: number;
}

export async function pullSettings<T>(namespace: SyncNamespace): Promise<RemoteSettings<T> | null> {
  return call<RemoteSettings<T>>(`/api/auth/settings/${encodeURIComponent(namespace)}`);
}

/**
 * Push settings.
 *
 * `version` is what the caller last saw. A mismatch comes back as null rather
 * than overwriting — another device wrote in between, and resolving that is
 * the caller's decision, not something to paper over.
 */
export async function pushSettings(
  namespace: SyncNamespace,
  payload: unknown,
  version?: number,
): Promise<{ version: number } | null> {
  return call<{ version: number }>(`/api/auth/settings/${encodeURIComponent(namespace)}`, {
    method: 'PUT',
    body: JSON.stringify({ payload: stripSecrets(namespace, payload), version }),
  });
}

/** Items changed since `since` (0 = everything). Deletions arrive as tombstones. */
export async function pullContent(kind: ContentKind, since = 0): Promise<SyncedContent[] | null> {
  const items: SyncedContent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ kind, since: String(since) });
    if (cursor) query.set('cursor', cursor);
    const res = await call<{ items: SyncedContent[]; nextCursor: string | null }>(
      `/api/auth/content?${query}`,
    );
    if (!res) return null;
    items.push(...res.items);
    cursor = res.nextCursor;
    // A repeated cursor is a server bug. Stop rather than turning background sync
    // into an infinite request loop on every client.
    if (cursor && seen.has(cursor)) return null;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export async function pushContent(
  items: { id: string; kind: ContentKind; name: string; payload: unknown; deleted?: boolean }[],
): Promise<boolean> {
  if (items.length === 0) return true;
  const res = await call<{ ok: boolean }>('/api/auth/content', {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
  return res?.ok === true;
}

/**
 * Prove ownership to Market with the plaintext edit key, then let Market write the
 * authenticated claim through Auth's private service binding. A caller-computed hash is
 * not proof: before this flow any account could submit any item id and claim it.
 */
export async function claimMarketItem(itemId: string, editKey: string): Promise<boolean> {
  if (!editKey.trim()) return false;
  const res = await call<{ ok: boolean }>(`/api/items/${encodeURIComponent(itemId)}/claim`, {
    method: 'POST',
    headers: { 'X-Edit-Key': editKey.trim() },
  });
  return res?.ok === true;
}

export async function listMarketClaims(): Promise<{ item_id: string; claimed_at: number }[]> {
  const res = await call<{ claims: { item_id: string; claimed_at: number }[] }>(
    '/api/auth/market-claims',
  );
  return res?.claims ?? [];
}
