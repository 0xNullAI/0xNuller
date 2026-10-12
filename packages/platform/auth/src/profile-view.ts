/**
 * Profile view logic, with no React and no network in it.
 *
 * Three things here fail silently if they are wrong, which is why they are
 * pure functions with tests rather than conditions spread through JSX:
 *
 * 1. **What a viewer is allowed to see.** Profiles require an account and
 *    blocks are indistinguishable from missing users. Private album entries
 *    stay filtered by the account service.
 *
 * 2. **Optimistic follow.** The button has to move on click and go back if the
 *    request fails. Rollback is the branch nobody exercises by hand.
 *
 * 3. **Mutual-follow.** It gates direct messages, so deriving it wrongly
 *    either hides a conversation people are entitled to or offers one that
 *    will be refused.
 */

import type { AuthUser, PublicPhoto, PublicUserView, UserProfile } from './index';

/**
 * The viewer's relationship to the profile's owner.
 *
 */
export type FollowRelationship = 'self' | 'none' | 'following' | 'followsYou' | 'mutual';

/**
 * What the UI may render.
 *
 */
export type ResolvedProfile =
  | { state: 'unavailable' }
  | {
      state: 'visible';
      user: AuthUser;
      profile: UserProfile;
      relationship: FollowRelationship;
      followers: number;
      following: number;
      createdAt: number | null;
      photos: PublicPhoto[];
    };

/**
 * An untouched profile. Every signed-in account has a public page.
 */
export function emptyProfile(): UserProfile {
  return {
    avatarUrl: null,
    bio: null,
    birthDate: null,
    location: null,
    links: [],
    interests: [],
    discoverable: true,
    visibility: 'public',
  };
}

export function deriveRelationship(input: {
  self: boolean;
  following: boolean;
  followedBy: boolean;
}): FollowRelationship {
  if (input.self) return 'self';
  if (input.following && input.followedBy) return 'mutual';
  if (input.following) return 'following';
  if (input.followedBy) return 'followsYou';
  return 'none';
}

/**
 * Fold the account service's answer into what the UI is allowed to draw.
 *
 * `view` being null already covers three different things — no such user,
 * a block in either direction, and an unreachable service — and the server
 * answers all three identically on purpose, so that a block cannot be detected
 * by probing. That collapse has to survive into the UI: every one of them is
 * `unavailable` and gets the same wording.
 *
 * A missing signed-in viewer is unavailable even if a caller supplies a stale
 * cached response. The server is authoritative for the profile and album.
 */
export function resolveProfileView(
  view: PublicUserView | null,
  viewerId: string | null,
): ResolvedProfile {
  if (!view || !viewerId) return { state: 'unavailable' };

  const self = viewerId != null && viewerId === view.user.id;
  const relationship = deriveRelationship({
    self,
    following: view.following,
    followedBy: view.followedBy,
  });

  // Looking at yourself is always open, including before you have saved
  // anything. A brand-new account has no profile row at all, and treating that
  // as "hidden" would show the owner the stranger's view of themselves with no
  // way to start filling it in.
  const profile = view.profile ?? emptyProfile();

  return {
    state: 'visible',
    user: view.user,
    profile,
    relationship,
    // Older service responses may lack counts; render zero until refreshed.
    followers: view.counts?.followers ?? 0,
    following: view.counts?.following ?? 0,
    createdAt: view.createdAt,
    photos: view.photos,
  };
}

/**
 * Follow button state.
 *
 * `pending` doubles as the in-flight marker and the rollback snapshot, so the
 * two cannot get out of step — there is no way to be mid-request without the
 * value to return to, or to hold a stale snapshot after settling.
 */
export interface FollowState {
  following: boolean;
  followedBy: boolean;
  /** null when the viewer is not allowed to know the number. */
  followerCount: number | null;
  pending: { following: boolean; followerCount: number | null } | null;
}

export function followStateFrom(resolved: ResolvedProfile): FollowState {
  const rel = resolved.state === 'unavailable' ? 'none' : resolved.relationship;
  return {
    following: rel === 'following' || rel === 'mutual',
    followedBy: rel === 'followsYou' || rel === 'mutual',
    followerCount: resolved.state === 'visible' ? resolved.followers : null,
    pending: null,
  };
}

/**
 * Flip the button before the request returns.
 *
 * A second click while one is in flight is ignored rather than queued. Two
 * toggles racing means the final server state is decided by which response
 * arrives last, and the button would settle on whichever that was — the user
 * would see their last click undone with no error to explain it.
 *
 * The follower count moves with the button, otherwise the number contradicts
 * the state right next to it for the length of a round trip.
 */
export function beginFollowToggle(state: FollowState): FollowState {
  if (state.pending) return state;
  const next = !state.following;
  return {
    ...state,
    following: next,
    followerCount:
      state.followerCount == null
        ? null
        : // Clamped: a count that was already stale must not go negative and
          // turn a display problem into an obviously broken one.
          Math.max(0, state.followerCount + (next ? 1 : -1)),
    pending: { following: state.following, followerCount: state.followerCount },
  };
}

/**
 * Settle the in-flight toggle. On failure the snapshot goes back verbatim.
 *
 * `followedBy` is never touched by either path: whether they follow you cannot
 * change because you pressed a button, so restoring it would be restoring
 * something that was never optimistic — and would clobber a real update that
 * arrived while the request was out.
 */
export function settleFollowToggle(state: FollowState, ok: boolean): FollowState {
  if (!state.pending) return state;
  if (ok) return { ...state, pending: null };
  return {
    ...state,
    following: state.pending.following,
    followerCount: state.pending.followerCount,
    pending: null,
  };
}

/** Both directions exist. This is the whole definition of a contact. */
export function isMutual(state: FollowState): boolean {
  return state.following && state.followedBy;
}

/**
 * May the viewer open a direct message with this person?
 *
 * Mutual follow is the gate: a conversation needs both sides to have opted in,
 * and following someone is the opt-in. It is deliberately not enough to be
 * followed — that would let anyone start a conversation by following first,
 * which is the exact shape of unsolicited contact this product cannot afford.
 *
 * Blocked to a viewer with a follow still in flight. The optimistic state says
 * mutual before the server has agreed, and starting a conversation on the
 * strength of a request that may still fail would open a thread the other side
 * never accepted.
 */
export function canDirectMessage(state: FollowState, relationship: FollowRelationship): boolean {
  if (relationship === 'self') return false;
  return isMutual(state) && state.pending == null;
}
