import { describe, expect, it } from 'vitest';
import {
  beginFollowToggle,
  canDirectMessage,
  deriveRelationship,
  followStateFrom,
  isMutual,
  resolveProfileView,
  settleFollowToggle,
  type FollowState,
} from './profile-view';
import type { PublicUserView, UserProfile } from './index';

const OTHER = { id: 'u-other', username: 'other', displayName: '别人' };
const ME = { id: 'u-me', username: 'me', displayName: '我' };

function profile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    avatarUrl: null,
    bio: '简介',
    birthDate: null,
    location: '上海',
    links: [],
    visibility: 'public',
    ...over,
  };
}

function view(over: Partial<PublicUserView> = {}): PublicUserView {
  return {
    user: OTHER,
    profile: profile(),
    following: false,
    followedBy: false,
    counts: { followers: 12, following: 3 },
    createdAt: 1_700_000_000_000,
    photos: [],
    ...over,
  };
}

describe('主页可见性', () => {
  it('公开资料对任何人都完整展示', () => {
    const r = resolveProfileView(view(), ME.id);
    expect(r.state).toBe('visible');
    if (r.state !== 'visible') return;
    expect(r.profile.bio).toBe('简介');
    expect(r.followers).toBe(12);
    expect(r.following).toBe(3);
    expect(r.createdAt).toBe(1_700_000_000_000);
  });

  it('未登录也能看公开资料——匿名使用是硬约束', () => {
    const r = resolveProfileView(view(), null);
    expect(r.state).toBe('visible');
    if (r.state !== 'visible') return;
    expect(r.relationship).toBe('anonymous');
  });

  it('私密资料对别人只剩用户名，不泄露任何计数', () => {
    // What the server actually sends for a private profile.
    const r = resolveProfileView(
      view({ profile: null, counts: null, createdAt: null }),
      ME.id,
    );
    expect(r.state).toBe('hidden');
    if (r.state !== 'hidden') return;
    expect(r.user.username).toBe('other');
    // The shape itself must not carry the numbers — a field that exists is a
    // field somebody renders.
    expect(r).not.toHaveProperty('followers');
    expect(r).not.toHaveProperty('following');
    expect(r).not.toHaveProperty('createdAt');
    expect(r).not.toHaveProperty('photos');
  });

  it('关注了对方也不会解锁私密资料', () => {
    const r = resolveProfileView(
      view({ profile: null, counts: null, following: true, followedBy: true }),
      ME.id,
    );
    expect(r.state).toBe('hidden');
  });

  it('服务端漏发了 visibility 标记时按更严格的一边处理', () => {
    // A future server that sends the body but leaves the flag private: the two
    // disagree, and the restrictive reading has to win.
    const r = resolveProfileView(view({ profile: profile({ visibility: 'private' }) }), ME.id);
    expect(r.state).toBe('hidden');
  });

  it('被拉黑与账号不存在得到同一个结果', () => {
    // getUser returns null for both, plus for an unreachable service. If they
    // resolved differently a block could be detected by probing.
    expect(resolveProfileView(null, ME.id)).toEqual({ state: 'unavailable' });
    expect(resolveProfileView(null, null)).toEqual({ state: 'unavailable' });
  });

  it('自己的私密资料对自己完整可见', () => {
    const r = resolveProfileView(
      view({ user: ME, profile: profile({ visibility: 'private' }) }),
      ME.id,
    );
    expect(r.state).toBe('visible');
    if (r.state !== 'visible') return;
    expect(r.relationship).toBe('self');
  });

  it('刚注册、还没填过资料时自己看到的是可编辑的空资料', () => {
    const r = resolveProfileView(view({ user: ME, profile: null }), ME.id);
    expect(r.state).toBe('visible');
    if (r.state !== 'visible') return;
    expect(r.profile.visibility).toBe('private');
    expect(r.profile.links).toEqual([]);
  });

  it('资料可见但服务端没给计数时显示 0 而不是 NaN', () => {
    const r = resolveProfileView(view({ counts: null }), ME.id);
    expect(r.state).toBe('visible');
    if (r.state !== 'visible') return;
    expect(r.followers).toBe(0);
    expect(r.following).toBe(0);
  });
});

describe('关注关系', () => {
  it('两个方向都存在才是互相关注', () => {
    const rel = (following: boolean, followedBy: boolean) =>
      deriveRelationship({ self: false, signedIn: true, following, followedBy });
    expect(rel(true, true)).toBe('mutual');
    expect(rel(true, false)).toBe('following');
    expect(rel(false, true)).toBe('followsYou');
    expect(rel(false, false)).toBe('none');
  });

  it('未登录不是「没有关注」，是没有身份可以关注', () => {
    expect(
      deriveRelationship({ self: false, signedIn: false, following: false, followedBy: false }),
    ).toBe('anonymous');
  });

  it('自己永远优先于其他关系', () => {
    expect(
      deriveRelationship({ self: true, signedIn: true, following: true, followedBy: true }),
    ).toBe('self');
  });
});

describe('乐观关注', () => {
  const base: FollowState = {
    following: false,
    followedBy: false,
    followerCount: 5,
    pending: null,
  };

  it('点下去按钮和粉丝数一起动', () => {
    const next = beginFollowToggle(base);
    expect(next.following).toBe(true);
    expect(next.followerCount).toBe(6);
    expect(next.pending).toEqual({ following: false, followerCount: 5 });
  });

  it('失败后按钮和粉丝数一起还原', () => {
    const rolled = settleFollowToggle(beginFollowToggle(base), false);
    expect(rolled.following).toBe(false);
    expect(rolled.followerCount).toBe(5);
    expect(rolled.pending).toBeNull();
  });

  it('成功后保留乐观值并清掉回滚快照', () => {
    const settled = settleFollowToggle(beginFollowToggle(base), true);
    expect(settled.following).toBe(true);
    expect(settled.followerCount).toBe(6);
    expect(settled.pending).toBeNull();
  });

  it('取消关注失败也能还原', () => {
    const followed: FollowState = { ...base, following: true, followerCount: 5 };
    const rolled = settleFollowToggle(beginFollowToggle(followed), false);
    expect(rolled.following).toBe(true);
    expect(rolled.followerCount).toBe(5);
  });

  it('请求还没回来时再点一次会被忽略', () => {
    const inflight = beginFollowToggle(base);
    expect(beginFollowToggle(inflight)).toBe(inflight);
  });

  it('回滚不会覆盖对方的关注状态', () => {
    // followedBy cannot change because of your own click, so restoring it
    // would clobber a real update that landed mid-request.
    const started = beginFollowToggle({ ...base, followedBy: true });
    const rolled = settleFollowToggle(started, false);
    expect(rolled.followedBy).toBe(true);
  });

  it('计数未知时保持未知，不会凭空变成 1', () => {
    const unknown: FollowState = { ...base, followerCount: null };
    expect(beginFollowToggle(unknown).followerCount).toBeNull();
  });

  it('粉丝数不会被减成负数', () => {
    const stale: FollowState = { ...base, following: true, followerCount: 0 };
    expect(beginFollowToggle(stale).followerCount).toBe(0);
  });

  it('没有请求在飞时结算是空操作', () => {
    expect(settleFollowToggle(base, false)).toBe(base);
  });

  it('从服务端答案初始化时不带任何在途状态', () => {
    const state = followStateFrom(
      resolveProfileView(view({ following: true, followedBy: true }), ME.id),
    );
    expect(state).toEqual({
      following: true,
      followedBy: true,
      followerCount: 12,
      pending: null,
    });
    expect(isMutual(state)).toBe(true);
  });
});

describe('私聊入口', () => {
  const mutual: FollowState = {
    following: true,
    followedBy: true,
    followerCount: 1,
    pending: null,
  };

  it('互相关注才开放', () => {
    expect(canDirectMessage(mutual, 'mutual')).toBe(true);
    expect(canDirectMessage({ ...mutual, followedBy: false }, 'following')).toBe(false);
    expect(canDirectMessage({ ...mutual, following: false }, 'followsYou')).toBe(false);
  });

  it('单方面被关注不能开私聊——否则关注一下就能私信任何人', () => {
    const onlyThem: FollowState = { ...mutual, following: false };
    expect(canDirectMessage(onlyThem, 'followsYou')).toBe(false);
  });

  it('关注请求还没确认时不开放', () => {
    const inflight = beginFollowToggle({ ...mutual, following: false });
    expect(isMutual(inflight)).toBe(true);
    expect(canDirectMessage(inflight, 'mutual')).toBe(false);
  });

  it('未登录和对自己都不开放', () => {
    expect(canDirectMessage(mutual, 'anonymous')).toBe(false);
    expect(canDirectMessage(mutual, 'self')).toBe(false);
  });
});
