import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as AuthModule from '@0xnullai/auth';
import type { AuthUser, ContactActionResult, PublicUserView, UserProfile } from '@0xnullai/auth';

/**
 * The wiring between the account service's answer and what ends up on screen.
 *
 * The pure decisions are tested in @0xnullai/auth's profile-view tests; what is
 * checked here is that the dialog actually obeys them. Both failure modes are
 * silent: a leaked follower count on a private profile looks like a working
 * page, and a follow that never rolls back looks like a follow that worked.
 */

const getUser = vi.fn<(username: string) => Promise<PublicUserView | null>>();
const followUser = vi.fn<(id: string) => Promise<ContactActionResult>>();
const unfollowUser = vi.fn<(id: string) => Promise<ContactActionResult>>();
const openDirectMessage = vi.fn<(id: string) => void>();

vi.mock('@0xnullai/auth', async () => {
  // Only the network calls are replaced. The gating and the follow reducer are
  // the real ones — stubbing those would test the stub.
  const actual = await vi.importActual<typeof AuthModule>('@0xnullai/auth');
  return {
    ...actual,
    getUser: (username: string) => getUser(username),
    followUser: (id: string) => followUser(id),
    unfollowUser: (id: string) => unfollowUser(id),
  };
});

vi.mock('../dm-entry', () => ({
  openDirectMessage: (id: string) => openDirectMessage(id),
}));

const { ProfileDialog } = await import('./ProfileDialog');

const VIEWER: AuthUser = { id: 'u-me', username: 'me', displayName: '我' };
const TARGET: AuthUser = { id: 'u-them', username: 'them', displayName: '对方' };

function profile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    avatarUrl: null,
    bio: '一句话简介',
    birthDate: null,
    location: '上海',
    links: [],
    visibility: 'public',
    ...over,
  };
}

function view(over: Partial<PublicUserView> = {}): PublicUserView {
  return {
    user: TARGET,
    profile: profile(),
    following: false,
    followedBy: false,
    counts: { followers: 42, following: 7 },
    createdAt: Date.UTC(2024, 2, 15),
    photos: [],
    ...over,
  };
}

function open(viewer: AuthUser | null = VIEWER, onClose = () => undefined) {
  return render(<ProfileDialog username="them" viewer={viewer} onClose={onClose} />);
}

beforeEach(() => {
  getUser.mockReset();
  followUser.mockReset();
  unfollowUser.mockReset();
  openDirectMessage.mockReset();
});
afterEach(cleanup);

describe('用户主页', () => {
  it('公开资料展示简介、地区、加入时间与关注数', async () => {
    getUser.mockResolvedValue(view());
    open();
    expect(await screen.findByText('一句话简介')).toBeTruthy();
    expect(screen.getByText('上海')).toBeTruthy();
    expect(screen.getByText('2024 年 3 月加入')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('私密资料一个数字都不显示', async () => {
    // What the server sends for a profile the viewer may not see.
    getUser.mockResolvedValue(view({ profile: null, counts: null, createdAt: null }));
    const { container } = open();
    expect(await screen.findByText(/仅自己可见/)).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
    expect(screen.queryByText('粉丝')).toBeNull();
    // Nothing shaped like a count survived anywhere in the rendered dialog.
    expect(container.textContent).not.toMatch(/\d+\s*(粉丝|关注数)/);
  });

  it('被拉黑与账号不存在给出同一句话', async () => {
    getUser.mockResolvedValue(null);
    open();
    expect(await screen.findByText('没有找到这个用户。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关注' })).toBeNull();
  });

  it('未登录仍然能看公开主页，只是不能关注', async () => {
    getUser.mockResolvedValue(view());
    open(null);
    expect(await screen.findByText('一句话简介')).toBeTruthy();
    expect(screen.getByText('登录后可以关注和私聊。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关注' })).toBeNull();
  });

  it('关注成功后按钮和粉丝数都留在新值', async () => {
    getUser.mockResolvedValue(view());
    followUser.mockResolvedValue({ ok: true });
    open();
    fireEvent.click(await screen.findByRole('button', { name: '关注' }));

    expect(await screen.findByRole('button', { name: '已关注' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('43')).toBeTruthy());
  });

  it('关注失败后按钮和粉丝数一起回滚，并说明原因', async () => {
    getUser.mockResolvedValue(view());
    let settle: (r: ContactActionResult) => void = () => undefined;
    followUser.mockReturnValue(
      new Promise<ContactActionResult>((resolve) => {
        settle = resolve;
      }),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: '关注' }));

    // Optimistic while the request is out.
    expect(screen.getByText('43')).toBeTruthy();

    await act(async () => {
      settle({ ok: false, error: '对方拒绝了' });
    });

    expect(await screen.findByRole('button', { name: '关注' })).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('对方拒绝了')).toBeTruthy();
  });

  it('互相关注才开放私聊', async () => {
    getUser.mockResolvedValue(view({ following: true, followedBy: true }));
    open();
    // 互相关注 is the badge by the name; the button reports only your own side,
    // so the same words never appear twice.
    expect(await screen.findByText('互相关注')).toBeTruthy();
    expect(screen.getByRole('button', { name: '已关注' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '互相关注' })).toBeNull();
    // The gate is the only thing that disables it now that direct messages
    // exist; mutual means the button acts.
    const dm = screen.getByRole('button', { name: /私聊/ });
    expect(dm.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('互相关注之后才能私聊。')).toBeNull();
  });

  it('打开私聊后关闭用户主页，不让主页继续盖住聊天', async () => {
    const onClose = vi.fn();
    getUser.mockResolvedValue(view({ following: true, followedBy: true }));
    open(VIEWER, onClose);

    fireEvent.click(await screen.findByRole('button', { name: /私聊/ }));

    expect(openDirectMessage).toHaveBeenCalledWith(TARGET.id);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('只有单向关注时私聊按钮被禁用并说明门槛', async () => {
    getUser.mockResolvedValue(view({ following: true, followedBy: false }));
    open();
    const dm = await screen.findByRole('button', { name: /私聊/ });
    expect(dm.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('互相关注之后才能私聊。')).toBeTruthy();
  });

  it('看自己的主页时是编辑入口而不是关注按钮', async () => {
    getUser.mockResolvedValue(view({ user: VIEWER, profile: profile({ visibility: 'private' }) }));
    open();
    expect(await screen.findByRole('button', { name: /编辑资料/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关注' })).toBeNull();
    expect(screen.getByText('目前只有你自己能看到这些。')).toBeTruthy();
  });

  it('编辑态说明全部选填，且住址一栏给出人身安全提示', async () => {
    getUser.mockResolvedValue(view({ user: VIEWER }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /编辑资料/ }));
    expect(screen.getByText('全部选填')).toBeTruthy();
    expect(screen.getByText(/不要填详细住址/)).toBeTruthy();
  });
});
