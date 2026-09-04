import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModuleSettingsSection } from '@0xnullai/ui';
import {
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  type DeviceSummary,
} from '@dg-kit/safety';
import { Shell } from './Shell';
import { ANDROID_DOWNLOAD_URL } from './Sidebar';

const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    username: string;
    displayName: string;
    emailVerified: boolean;
    email?: string;
  },
}));

/**
 * Does device control actually change hands when you switch modules?
 *
 * The behavior of the lease itself is already covered by the device-lease /
 * safety-chain tests in `@dg-kit/safety`. What is verified here is **whether the
 * shell calls into it** — that was exactly the lesson of the previous round:
 * `registerSafetySession`'s logic was entirely correct and its tests were green,
 * but nothing in the whole repo called it, so the global stop button was never
 * rendered at all.
 *
 * Correct logic that nobody calls is the failure mode this kind of contract runs
 * into most easily, and the hardest one to spot from unit tests.
 */

// The modules are lazily loaded real apps and cannot run under jsdom (BLE, Worker,
// audio). All that matters here is what the shell does after the route changes, so
// the four modules are replaced with stubs.
vi.mock('./routes', async () => {
  const { lazy } = await import('react');
  const stub = (label: string, settings = false) =>
    lazy(() =>
      Promise.resolve({
        default: () => (
          <>
            <div>{label} 模块</div>
            {settings && (
              <ModuleSettingsSection id="agent-waveforms" label="波形" order={30}>
                波形内容
              </ModuleSettingsSection>
            )}
          </>
        ),
      }),
    );
  return {
    MODULES: [
      { id: 'control', label: 'Control', blurb: '', Component: stub('Control') },
      { id: 'agent', label: 'Agent', blurb: '', Component: stub('Agent', true) },
      { id: 'chat', label: 'Chat', blurb: '', Component: stub('Chat') },
    ],
    moduleIdFromPath: (p: string) => {
      const id = p.replace(/^\//, '');
      return id === 'control' || id === 'agent' || id === 'chat' ? id : null;
    },
  };
});

// The account service is unreachable in tests; signed out is its normal fallback path.
vi.mock('@0xnullai/auth', () => ({
  avatarSrc: () => null,
  confirmEmailVerification: async () => {
    if (authState.user) authState.user = { ...authState.user, emailVerified: true };
  },
  dmConversations: () => Promise.resolve(null),
  getReferralSummary: () =>
    Promise.resolve({
      code: 'TESTINVITE01',
      balanceCents: 0,
      rewardCents: 500,
      rewardedCount: 0,
      pendingCount: 0,
    }),
  me: () => Promise.resolve(authState.user),
  logout: () => Promise.resolve(),
  // The shell subscribes to profile requests on mount. Nothing here asks for a
  // profile, so an unsubscribe that does nothing is the whole stub.
  subscribeProfileRequests: () => () => undefined,
  subscribeProfileChanges: () => () => undefined,
}));

const cleanups: (() => void)[] = [];

function fakeModule(id: string, devices: DeviceSummary[]) {
  const stop = vi.fn();
  const onRevoke = vi.fn();
  cleanups.push(
    registerSafetySession({
      id,
      label: id,
      isActive: () => devices.length > 0,
      stop,
      onRevoke,
      devices: () => devices,
    }),
  );
  return { stop, onRevoke };
}

beforeEach(async () => {
  authState.user = null;
  window.history.pushState(null, '', '/agent');
  await grantDeviceLease(null);
});

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await grantDeviceLease(null);
  cleanup();
});

const COYOTE: DeviceSummary = { id: 'c', kind: 'coyote', name: '47L1', connected: true };

describe('外壳与设备控制权', () => {
  it('把设备状态和模块操作归入同一个顶部栏', async () => {
    fakeModule('agent', [COYOTE]);
    await act(async () => {
      render(<Shell />);
    });

    const actions = document.getElementById('shl-actions');
    const deviceBar = document.getElementById('shl-device-bar');
    const topbar = document.getElementById('shl-topbar');
    expect(actions).toBeTruthy();
    expect(deviceBar).toBeTruthy();
    expect(actions!.parentElement).toBe(topbar);
    expect(deviceBar!.parentElement).toBe(topbar);
    expect(
      actions!.compareDocumentPosition(deviceBar!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getByRole('main', { name: 'Agent' })).toBeTruthy();
  });

  it('窄屏抽屉支持 Escape 关闭并把焦点交还触发按钮', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        ({
          matches: query === '(max-width: 767px)',
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });

    try {
      await act(async () => {
        render(<Shell />);
      });
      const trigger = screen.getByRole('button', { name: '打开侧边栏' });
      fireEvent.click(trigger);

      expect(screen.getByRole('complementary', { name: '主导航' })).toBeTruthy();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByRole('complementary', { name: '主导航' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      cleanup();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it('在说明下面提供始终指向最新版 APK 的 Android 下载入口', async () => {
    await act(async () => {
      render(<Shell />);
    });

    fireEvent.click(screen.getByRole('button', { name: '未登录' }));
    const download = screen.getByRole('menuitem', { name: '下载 Android 版' });
    expect(download.getAttribute('href')).toBe(ANDROID_DOWNLOAD_URL);
    expect(download.getAttribute('target')).toBe('_blank');
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.at(-2)?.textContent).toContain('说明');
    expect(menuItems.at(-1)).toBe(download);
  });

  it('设置导航稳定，只有进入波形页才挂载 Agent', async () => {
    window.history.pushState(null, '', '/control');
    await act(async () => {
      render(<Shell />);
    });

    expect(screen.queryByRole('button', { name: '波形' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '未登录' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '软件设置' }));
    // Wait for the actual lazy import, not Testing Library's one-second polling budget.
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    const waveforms = await screen.findByRole('button', { name: '波形' });
    expect(screen.queryByText('Agent 模块')).toBeNull();
    fireEvent.click(waveforms);
    expect(await screen.findByText('波形内容')).toBeTruthy();
    expect(screen.getByText('Control 模块')).toBeTruthy();
  });

  it('未登录时不挂载 Chat', async () => {
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });

    expect(await screen.findByText('登录后使用 Chat')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录 / 注册' })).toBeTruthy();
    expect(screen.queryByText('Chat 模块')).toBeNull();
  });

  it('邮箱未验证时不挂载 Chat，并引导到账户验证', async () => {
    authState.user = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      emailVerified: false,
      email: 'alice@example.com',
    };
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });

    expect(await screen.findByText('验证邮箱后使用 Chat')).toBeTruthy();
    expect(screen.getByRole('button', { name: '前往账户验证' })).toBeTruthy();
    expect(screen.queryByText('Chat 模块')).toBeNull();
  });

  it('邮箱已验证时挂载 Chat', async () => {
    authState.user = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      emailVerified: true,
    };
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });

    expect(await screen.findByText('Chat 模块')).toBeTruthy();
    expect(screen.queryByText('验证邮箱后使用 Chat')).toBeNull();
  });

  it('验证邮件链接直接打开账户设置并立即刷新验证状态', async () => {
    authState.user = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      emailVerified: false,
      email: 'alice@example.com',
    };
    window.history.pushState(null, '', '/settings?verify=test-token');
    await act(async () => {
      render(<Shell />);
    });

    expect(await screen.findByText('邮箱验证成功')).toBeTruthy();
    expect(screen.getByText('已验证')).toBeTruthy();
  });

  it('挂载时把租约给当前模块', async () => {
    fakeModule('agent', [COYOTE]);
    await act(async () => {
      render(<Shell />);
    });
    expect(hasDeviceLease('agent')).toBe(true);
  });

  it('切换模块时租约转手，原模块收到撤权通知', async () => {
    const agent = fakeModule('agent', [COYOTE]);
    fakeModule('chat', []);

    await act(async () => {
      render(<Shell />);
    });
    expect(hasDeviceLease('agent')).toBe(true);

    // Go through the real navigation path (the shell's pushState + popstate sync)
    // instead of calling grantDeviceLease directly — what is under test is whether
    // the shell calls it on a route change.
    await act(async () => {
      window.history.pushState(null, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(hasDeviceLease('chat')).toBe(true);
    expect(hasDeviceLease('agent')).toBe(false);
    // The module that was switched away from must be notified so it stops output and
    // clears the accumulated press-and-hold state.
    // Flipping the lease flag alone is not enough: remote commands do not go through the UI.
    expect(agent.onRevoke).toHaveBeenCalled();
  });

  it('回到首页时没有任何模块持有租约，但全局安全按钮还在', async () => {
    fakeModule('agent', [COYOTE]);
    await act(async () => {
      render(<Shell />);
    });

    await act(async () => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(hasDeviceLease('agent')).toBe(false);
    // The home page is the easiest spot to miss: render the device bar as if it were
    // part of a module and it disappears once you go back home — while the device is
    // still attached to someone, which is exactly when the zero-output safety action is needed.
    expect(screen.getByRole('button', { name: /归零/ })).toBeTruthy();
  });

  it('设备栏与全局安全按钮不随模块切换消失——设备还连着', async () => {
    fakeModule('agent', [COYOTE]);
    fakeModule('chat', []);

    await act(async () => {
      render(<Shell />);
    });
    expect(screen.getByRole('button', { name: /归零/ })).toBeTruthy();

    await act(async () => {
      window.history.pushState(null, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // Handing over control is not the same as disconnecting the device. As long as the
    // device is still on someone's body, the zero-output action has to still be there.
    expect(screen.getByRole('button', { name: /归零/ })).toBeTruthy();
  });
});
