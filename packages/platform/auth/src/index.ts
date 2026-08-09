/**
 * Account client.
 *
 * It deliberately exposes no device-related API. This is a structural
 * guarantee, not a convention: accounts handle identity and data ownership
 * only, while device control is always granted in person, explicitly, and
 * revocably — independent of who is logged in. A stolen account in this
 * product would otherwise mean control over someone's body, so even your
 * own second device logged into the same account cannot remotely control
 * the Coyote you are using.
 *
 * Two session carriers: the web uses HttpOnly cookies (shared across
 * modules under one registrable domain); Android uses Bearer tokens — the
 * Tauri WebView's origin is a local scheme and can never receive the web
 * domain's cookies.
 */

import { apiBaseUrl } from '@0xnullai/settings';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

// Auth endpoints live under `/api/auth` on the unified domain (paths are
// written at each call site), so only the origin is needed here: empty
// string on the web (same-origin); the Tauri shell gets an absolute origin
// from apiBaseUrl().

/** Android stores the token here; empty on the web, which relies on cookies. */
const TOKEN_KEY = '0xnullai.auth-token';

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing may reject the write: the session still works (the
    // in-memory state remains) but a refresh will require logging in again.
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = storedToken();
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) || `请求失败（${res.status}）`);
  return data as T;
}

export async function register(input: {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
}): Promise<AuthUser> {
  const r = await call<{ user: AuthUser; token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  setStoredToken(r.token);
  return r.user;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const r = await call<{ user: AuthUser; token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setStoredToken(r.token);
  return r.user;
}

export async function me(): Promise<AuthUser | null> {
  const r = await call<{ user: AuthUser | null }>('/api/auth/me');
  return r.user;
}

export async function logout(): Promise<void> {
  await call('/api/auth/logout', { method: 'POST' });
  setStoredToken(null);
}

/** Hard-delete the account. Users of this product category care intensely about whether deletion is real — so it is a real delete, not a flag. */
export async function deleteAccount(): Promise<void> {
  await call('/api/auth/account', { method: 'DELETE' });
  setStoredToken(null);
}

/**
 * Profile.
 *
 * Every field is optional and an account that fills in nothing works exactly
 * as well — for this product, being asked for personal details as a
 * precondition would be a reason to walk away.
 *
 * Two fields are deliberately narrower than they first look:
 *
 * `location` is region-level, not a street address. For this category of
 * product, a home address sitting in a database is a physical-safety risk if
 * it ever leaks, and nothing in the product needs that precision.
 *
 * `visibility` defaults to private. Defaulting to public would publish
 * details before someone has decided to, and this is information that cannot
 * be un-seen once it has been shown.
 */
export interface UserProfile {
  avatarUrl: string | null;
  bio: string | null;
  /** YYYY-MM-DD. Used to confirm the account holder is an adult. */
  birthDate: string | null;
  /** City or region. Not a street address — see above. */
  location: string | null;
  links: string[];
  visibility: 'private' | 'public';
}

export interface UserPhoto {
  id: string;
  object_key: string;
  caption: string | null;
  visibility: 'private' | 'public';
  created_at: number;
}

export async function getProfile(): Promise<UserProfile | null> {
  const r = await call<{ profile: UserProfile | null }>('/api/auth/profile');
  return r.profile;
}

export async function saveProfile(profile: Partial<UserProfile>): Promise<void> {
  await call('/api/auth/profile', { method: 'PUT', body: JSON.stringify(profile) });
}

export async function listPhotos(): Promise<UserPhoto[]> {
  const r = await call<{ photos: UserPhoto[] }>('/api/auth/photos');
  return r.photos;
}

export async function deletePhoto(id: string): Promise<void> {
  await call(`/api/auth/photos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Contacts.
 *
 * Following is directional; a **contact** is both directions existing, which is
 * what `mutual` reports. There is no separate friendship concept anywhere in
 * the stack — see the auth worker's 0004_contacts.sql.
 *
 * **Nothing below throws.** Every other function in this file rejects on a
 * failed request, and callers there are already inside a flow the user started
 * by signing in. Contacts are different: the surface can be reached while
 * signed out, and the account service can simply be unreachable — anonymous use
 * is a hard product constraint, so an unavailable server has to read as "no
 * contacts", never as a crash inside the shell. Reads therefore degrade to an
 * empty page and writes report failure in the return value.
 *
 * The rules themselves are not implemented here. Self-follow, following someone
 * who blocked you and blocking removing follows are all enforced by the server;
 * this layer only carries the answer back.
 */

export interface Contact {
  id: string;
  username: string;
  displayName: string;
  /** Epoch ms the follow was created. Lists come back newest first. */
  followedAt: number;
  /** Both directions of the follow exist — the two of you are contacts. */
  mutual: boolean;
}

export interface ContactPage {
  users: Contact[];
  /** Offset for the next page, or null at the end of the list. */
  nextOffset: number | null;
}

export interface BlockedUser {
  id: string;
  username: string;
  displayName: string;
  blockedAt: number;
}

/** One album entry as somebody else may see it. `url` is served by the account service. */
export interface PublicPhoto {
  id: string;
  caption: string | null;
  visibility: 'private' | 'public';
  createdAt: number;
  /** Path on the account service; combine with `photoSrc` before putting it in an <img>. */
  url: string;
}

/**
 * Another user as seen by someone else.
 *
 * `profile` is null unless it is public (or your own), and **everything that is
 * profile content rather than identity follows that same flag**: `counts` and
 * `createdAt` come back null and `photos` empty for a profile the viewer may
 * not see. They are separate fields rather than nested inside `profile` because
 * the server computes them separately — but the UI must treat them as one
 * decision, which is what `resolveProfileView` is for.
 *
 * A blocked viewer does not get this object at all; the lookup 404s and
 * `getUser` returns null, indistinguishable from "no such user".
 */
export interface PublicUserView {
  user: AuthUser;
  profile: UserProfile | null;
  /** You follow them. */
  following: boolean;
  /** They follow you. */
  followedBy: boolean;
  /** null means "not allowed to know", which is not the same as zero. */
  counts: { followers: number; following: number } | null;
  /** Epoch ms the account was created, or null when the profile is not visible. */
  createdAt: number | null;
  photos: PublicPhoto[];
}

/** Writes report failure rather than throwing; `error` carries the server's wording. */
export interface ContactActionResult {
  ok: boolean;
  error?: string;
}

const EMPTY_PAGE: ContactPage = { users: [], nextOffset: null };

async function contactAction(path: string, init: RequestInit): Promise<ContactActionResult> {
  try {
    await call(path, init);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '操作失败' };
  }
}

/** Paging is by offset, and the server caps the page size. Ids are never put in a query string. */
function pageQuery(options: { limit?: number; offset?: number } = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  const q = params.toString();
  return q ? `?${q}` : '';
}

async function contactPage(path: string): Promise<ContactPage> {
  try {
    const r = await call<ContactPage>(path);
    return { users: r.users ?? [], nextOffset: r.nextOffset ?? null };
  } catch {
    return EMPTY_PAGE;
  }
}

export function listFollowing(options?: { limit?: number; offset?: number }): Promise<ContactPage> {
  return contactPage(`/api/auth/following${pageQuery(options)}`);
}

export function listFollowers(options?: { limit?: number; offset?: number }): Promise<ContactPage> {
  return contactPage(`/api/auth/followers${pageQuery(options)}`);
}

export function followUser(userId: string): Promise<ContactActionResult> {
  return contactAction('/api/auth/follow', { method: 'POST', body: JSON.stringify({ userId }) });
}

export function unfollowUser(userId: string): Promise<ContactActionResult> {
  return contactAction(`/api/auth/follow/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

/**
 * Block someone. The server also drops any follow in **both** directions — a
 * block that left the existing follow in place would not be a block.
 */
export function blockUser(userId: string): Promise<ContactActionResult> {
  return contactAction('/api/auth/block', { method: 'POST', body: JSON.stringify({ userId }) });
}

/** Unblocking does not restore the follows the block removed; they have to be made again. */
export function unblockUser(userId: string): Promise<ContactActionResult> {
  return contactAction(`/api/auth/block/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

export async function listBlocks(): Promise<BlockedUser[]> {
  try {
    return (await call<{ users: BlockedUser[] }>('/api/auth/blocks')).users ?? [];
  } catch {
    return [];
  }
}

/**
 * Look someone up by username — the only handle a person can type, and it goes
 * in the path rather than a query string.
 *
 * Returns null when there is no such user, when either of you has blocked the
 * other (deliberately the same answer, so a block cannot be detected), and when
 * the service is unreachable.
 */
export async function getUser(username: string): Promise<PublicUserView | null> {
  try {
    const r = await call<Partial<PublicUserView> & { user: AuthUser }>(
      `/api/auth/users/${encodeURIComponent(username)}`,
    );
    // Normalised rather than cast. The web shell and a deployed account service
    // are released separately, and an older service simply omits the newer
    // fields — read as `undefined` those would render as "NaN 关注" and crash on
    // `photos.map`. Absent has to mean "not allowed to know", which is also the
    // safe reading if the two ever disagree.
    return {
      user: r.user,
      profile: r.profile ?? null,
      following: r.following === true,
      followedBy: r.followedBy === true,
      counts: r.counts ?? null,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : null,
      photos: Array.isArray(r.photos) ? r.photos : [],
    };
  } catch {
    return null;
  }
}

/**
 * Absolute source for a photo returned by `getUser`.
 *
 * The service returns a path, not a URL, because it does not know which origin
 * the caller reached it on: the web is same-origin and the Tauri shell is not.
 * Resolving it here rather than server-side keeps that one difference in the
 * one place that already knows about it.
 */
export function photoSrc(photo: PublicPhoto): string {
  return `${apiBaseUrl()}${photo.url}`;
}

// Visibility gating, optimistic follow and the mutual-follow derivation. Kept
// in their own file because they are pure and tested; `import type` only in
// that direction, so re-exporting them here creates no runtime cycle.
export * from './profile-view';
// The shell-wide request to open somebody's profile. Any module can ask; only
// the shell renders.
export * from './profile-requests';

/**
 * Direct messages.
 *
 * The conversation itself is Chat's; this is only the part the account service owns —
 * whether two people may talk, and where their conversation lives. Both answers arrive
 * together as a short-lived signed ticket, because Chat has no way to ask: a WebSocket
 * upgrade carries no Authorization header, and the Android shell's origin can never hold
 * the web domain's cookie.
 *
 * The rule is **mutual follow**, enforced by the server. A one-way follow is not enough:
 * an inbox anyone can write to is an open harassment channel, and it cannot be closed
 * again after the fact.
 *
 * Like contacts above, **nothing here throws**. Every one of these is reachable while
 * signed out — the sidebar polls the conversation list — and anonymous use of the rest of
 * the app is a hard constraint, so 401 and an unreachable service both have to read as
 * "no conversations" rather than as an exception inside the shell.
 */

/** Admission to one conversation. Valid for about a minute; mint a new one per connect. */
export interface DmTicket {
  ticket: string;
  /** The conversation's id in Chat. Derived server-side; never computed by the client. */
  room: string;
  expiresAt: number;
}

export interface DmConversation {
  /** The other account. */
  id: string;
  username: string;
  displayName: string;
  startedAt: number;
  room: string;
}

export interface DmConversationList {
  conversations: DmConversation[];
  /** Covers exactly these conversations; Chat answers unread counts for no others. */
  ticket: string;
  expiresAt: number;
}

/**
 * Ask for admission to a conversation with someone.
 *
 * Null when you are not signed in, when the two of you are not mutual follows, when
 * either has blocked the other, and when the service is unreachable — the same
 * deliberate flattening the user lookup does, so a block cannot be told apart from a
 * missing account by probing.
 */
export async function dmTicket(userId: string): Promise<DmTicket | null> {
  try {
    return await call<DmTicket>('/api/auth/dm/ticket', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  } catch {
    return null;
  }
}

/** The conversations you are party to, re-authorized on every call. Empty when signed out. */
export async function dmConversations(): Promise<DmConversationList | null> {
  try {
    const r = await call<DmConversationList>('/api/auth/dm/conversations');
    return { conversations: r.conversations ?? [], ticket: r.ticket, expiresAt: r.expiresAt };
  } catch {
    return null;
  }
}

/**
 * The entry point into a conversation, for anything that shows a person — the profile page
 * above all. One call navigates and delivers the request; see dm-intent.ts.
 */
export { openDirectMessage, subscribeDmRequest, type DmRequest } from './dm-intent.js';

/** Whole years, or null when no birth date is set. Local-only; the server enforces 18+ on save. */
export function ageFromBirthDate(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  const age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  return beforeBirthday ? age - 1 : age;
}
