import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModuleSettingsSection, registerNavigationGuard } from '@0xnullai/ui';
import {
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  type DeviceSummary,
} from '@dg-kit/safety';
import { Shell } from './Shell';
import { CLIENT_DOWNLOAD_URL } from './product';

const authState = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    username: string;
    displayName: string;
    emailVerified: boolean;
    email?: string;
  },
  meFailure: null as Error | null,
  authListeners: new Set<(user: unknown) => void>(),
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
  const { useShellNav } = await import('@0xnullai/ui');
  // Like the real conversation modules, the stub shows the shell's back arrow in its header.
  function ConversationBack() {
    const back = useShellNav()?.conversationBack;
    return back ? (
      <button type="button" onClick={back}>
        返回消息
      </button>
    ) : null;
  }
  const stub = (label: string, settings = false) =>
    lazy(() =>
      Promise.resolve({
        default: () => (
          <>
            <ConversationBack />
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
      if (p === '/') return 'agent';
      const id = p.replace(/^\//, '');
      return id === 'control' || id === 'agent' || id === 'chat' ? id : null;
    },
  };
});

vi.mock('./UnifiedInbox', () => ({
  UnifiedInbox: () => <section aria-label="所有聊天">统一收件箱</section>,
}));

vi.mock('./ContactsDialog', () => ({
  ContactsDialog: () => <section aria-label="联系人列表">联系人</section>,
}));

vi.mock('./settings/PersonalMemoryContent', () => ({
  PersonalMemoryContent: () => <div>个人记忆内容</div>,
}));

// The shell reads account state once and reuses the account form at the entry gate.
vi.mock('@0xnullai/auth', () => ({
  avatarSrc: () => null,
  currentAuthUserId: () => authState.user?.id ?? null,
  confirmEmailVerification: async () => {
    if (authState.user) authState.user = { ...authState.user, emailVerified: true };
  },
  dmConversations: () => Promise.resolve(null),
  getReferralSummary: () =>
    Promise.resolve({
      code: 'TESTINVITE01',
      balanceCredits: 0,
      rewardCredits: 500,
      rewardedCount: 0,
      pendingCount: 0,
    }),
  getCreditBalance: () => Promise.resolve({ total: 0, reserved: 0, available: 0 }),
  getCreditLedger: () => Promise.resolve({ entries: [], nextOffset: null }),
  me: () =>
    authState.meFailure ? Promise.reject(authState.meFailure) : Promise.resolve(authState.user),
  login: async () => {
    authState.user = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      emailVerified: true,
    };
    return authState.user;
  },
  logout: () => Promise.resolve(),
  // The shell subscribes to profile requests on mount. Nothing here asks for a
  // profile, so an unsubscribe that does nothing is the whole stub.
  subscribeProfileRequests: () => () => undefined,
  subscribeProfileChanges: () => () => undefined,
  subscribeAuthChanges: (listener: (user: unknown) => void) => {
    authState.authListeners.add(listener);
    return () => authState.authListeners.delete(listener);
  },
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
  authState.user = {
    id: 'u1',
    username: 'alice',
    displayName: 'Alice',
    emailVerified: true,
  };
  authState.meFailure = null;
  authState.authListeners.clear();
  window.history.pushState(null, '', '/agent');
  await grantDeviceLease(null);
});

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await grantDeviceLease(null);
  cleanup();
});

const COYOTE: DeviceSummary = { id: 'c', kind: 'coyote', name: '47L1', connected: true };
const OPOSSUM: DeviceSummary = {
  id: 'o',
  kind: 'opossum',
  name: 'Opossum',
  connected: true,
  active: true,
  battery: 82,
};

describe('外壳与设备控制权', () => {
  it('旧的未知地址也显示统一消息列表而非模块入口', async () => {
    window.history.pushState(null, '', '/legacy-home');
    await act(async () => {
      render(<Shell />);
    });
    expect(screen.getByRole('region', { name: '所有聊天' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '功能模块' })).toBeNull();
  });

  it.each(['/u/%E0%A4%A', '/u/alice%2Fother'])(
    '无效个人主页链接不会使外壳崩溃：%s',
    async (path) => {
      window.history.pushState(null, '', path);
      await act(async () => {
        render(<Shell />);
      });
      expect(screen.getByRole('region', { name: '所有聊天' })).toBeTruthy();
      expect(screen.queryByRole('main', { name: '个人主页' })).toBeNull();
    },
  );

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

  it('窄屏使用消息首页和底部导航，进入聊天时返回首页并撤销后台租约', async () => {
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
      expect(screen.getByRole('button', { name: '返回消息' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '打开侧边栏' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '返回消息' }));
      expect(window.location.pathname).toBe('/');
      expect(screen.getByRole('region', { name: '所有聊天' })).toBeTruthy();
      expect(screen.getByRole('navigation', { name: '手机主导航' })).toBeTruthy();
      expect(hasDeviceLease('agent')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: '联系人' }));
      expect(window.location.pathname).toBe('/people');
      fireEvent.click(screen.getByRole('button', { name: /^我的$/ }));
      expect(await screen.findByRole('region', { name: '设置' })).toBeTruthy();
      expect(window.location.pathname).toBe('/settings/overview');
      expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '设备安全' }));
      expect(window.location.pathname).toBe('/settings/safety');
      expect(screen.getByRole('button', { name: '返回设置列表' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
      expect(window.location.pathname).toBe('/settings/overview');
      fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
      expect(screen.queryByRole('region', { name: '设置' })).toBeNull();
      expect(window.location.pathname).toBe('/people');
      expect(hasDeviceLease('agent')).toBe(false);
    } finally {
      cleanup();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it('侧栏只保留帮助与我的入口，下载放在设置的关于页', async () => {
    await act(async () => {
      render(<Shell />);
    });
    expect(screen.getByRole('button', { name: '帮助与文档' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '软件设置' })).toBeNull();
    expect(screen.queryByRole('link', { name: '客户端' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开我的设置' }));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    fireEvent.click(await screen.findByRole('button', { name: '关于' }));
    const download = await screen.findByRole('link', { name: '下载客户端' });
    expect(download.getAttribute('href')).toBe(CLIENT_DOWNLOAD_URL);
    expect(download.getAttribute('target')).toBe('_blank');
  });

  it('个人记忆作为设置二级页打开，不再嵌在账户展开区', async () => {
    await act(async () => {
      render(<Shell />);
    });
    fireEvent.click(screen.getByRole('button', { name: '打开我的设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '个人记忆' }));
    expect(window.location.pathname).toBe('/settings/memory');
    expect(await screen.findByText('个人记忆内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(window.location.pathname).toBe('/settings/account');
    expect(screen.queryByRole('button', { name: '个人记忆' })).toBeNull();
  });

  it('桌面使用导航栏，仅在聊天时单独显示消息列表', async () => {
    await act(async () => {
      render(<Shell />);
    });

    const root = document.getElementById('shl-root');
    // The navigation rail never contains the conversation list.
    expect(document.querySelector('#shl-rail [aria-label="所有聊天"]')).toBeNull();
    expect(document.querySelector('#shl-side [aria-label="所有聊天"]')).toBeTruthy();
    expect(root?.hasAttribute('data-inbox')).toBe(true);
    expect(screen.getByRole('region', { name: '所有聊天' })).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole('navigation', { name: '主要功能' })).getByRole('button', {
        name: '设备',
      }),
    );
    expect(root?.hasAttribute('data-inbox')).toBe(false);
    expect(screen.queryByRole('region', { name: '所有聊天' })).toBeNull();

    fireEvent.click(
      within(screen.getByRole('navigation', { name: '主要功能' })).getByRole('button', {
        name: '消息',
      }),
    );
    expect(window.location.pathname).toBe('/');
    expect(root?.hasAttribute('data-inbox')).toBe(true);
    expect(screen.getByRole('region', { name: '所有聊天' })).toBeTruthy();
  });

  it('设置导航稳定，只有进入波形页才挂载 Agent', async () => {
    window.history.pushState(null, '', '/control');
    await act(async () => {
      render(<Shell />);
    });

    expect(screen.queryByRole('button', { name: '波形' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开我的设置' }));
    // Wait for the actual lazy import, not Testing Library's one-second polling budget.
    await act(async () => {
      await vi.dynamicImportSettled();
    });

    const waveforms = await screen.findByRole('button', { name: '波形' });
    expect(screen.getByRole('region', { name: '设置' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull();
    expect(screen.queryByText('Agent 模块')).toBeNull();
    fireEvent.click(waveforms);
    expect(await screen.findByText('波形内容')).toBeTruthy();
    expect(screen.getByText('Control 模块')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
    expect(screen.getByRole('button', { name: '设备安全' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(screen.queryByRole('region', { name: '设置' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开我的设置' }));
    expect(await screen.findByRole('region', { name: '设置' })).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '主要功能' })).getByRole('button', {
        name: '设备',
      }),
    );
    expect(window.location.pathname).toBe('/control');
    expect(screen.queryByRole('region', { name: '设置' })).toBeNull();
  });

  it('未登录时只显示统一入口，不挂载任何页面，并在登录后回到原路径', async () => {
    authState.user = null;
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });

    expect(await screen.findByRole('main', { name: '账户登录' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '主要功能' })).toBeNull();
    expect(screen.queryByText('Chat 模块')).toBeNull();
    expect(hasDeviceLease('chat')).toBe(false);
    fireEvent.change(await screen.findByRole('textbox', { name: '用户名' }), {
      target: { value: 'alice' },
    });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('Chat 模块')).toBeTruthy();
    expect(window.location.pathname).toBe('/chat');
  });

  it('账户服务暂时不可用时提供重试，而不是显示登录表单', async () => {
    authState.user = { id: 'u1', username: 'alice', displayName: 'Alice', emailVerified: true };
    authState.meFailure = new Error('请求失败（503）');
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });
    expect(await screen.findByText('账户服务暂时无法连接。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '用户名' })).toBeNull();
    authState.meFailure = null;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('Chat 模块')).toBeTruthy();
  });

  it('会话失效时退回统一登录入口', async () => {
    authState.user = { id: 'u1', username: 'alice', displayName: 'Alice', emailVerified: true };
    window.history.pushState(null, '', '/chat');
    await act(async () => {
      render(<Shell />);
    });
    expect(await screen.findByText('Chat 模块')).toBeTruthy();
    act(() => {
      for (const listener of authState.authListeners) listener(null);
    });
    expect(await screen.findByRole('main', { name: '账户登录' })).toBeTruthy();
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

    expect(await screen.findByText('验证邮箱后使用聊天')).toBeTruthy();
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

  it('设置二级页可直接打开，并随浏览器历史恢复当前页', async () => {
    window.history.replaceState(null, '', '/settings/about');
    await act(async () => {
      render(<Shell />);
    });
    expect(await screen.findByRole('heading', { name: '关于' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载客户端' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
    expect(window.location.pathname).toBe('/settings/overview');
    expect(screen.getByRole('button', { name: '设备安全' })).toBeTruthy();

    await act(async () => {
      window.history.replaceState(null, '', '/settings/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('heading', { name: '关于' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回设置列表' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(window.location.pathname).toBe('/');
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

  it('首页复用 AI 聊天模块及其租约，全局安全按钮仍在', async () => {
    fakeModule('agent', [COYOTE]);
    await act(async () => {
      render(<Shell />);
    });

    await act(async () => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(hasDeviceLease('agent')).toBe(true);
    expect(screen.getAllByText('Agent 模块')).toHaveLength(1);
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

  it.each([false, true])('在%s窄屏设置页保留已连接设备的归零入口', async (narrow) => {
    const originalMatchMedia = window.matchMedia;
    if (narrow) window.history.replaceState(null, '', '/');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: narrow && query === '(max-width: 767px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    fakeModule('agent', [COYOTE]);
    try {
      await act(async () => {
        render(<Shell />);
      });
      await act(async () => {
        fireEvent.click(
          narrow
            ? screen.getByRole('button', { name: /^我的$/ })
            : screen.getByRole('button', { name: '打开我的设置' }),
        );
      });
      const settings = screen.getByRole('complementary', { name: '我的设置' });
      expect(within(settings).getByRole('button', { name: /归零/ })).toBeTruthy();
      expect(settings.querySelector('#shl-settings-device-bar')?.textContent).toContain('郊狼');
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it('多个模块连接多台设备时合并展示且只有一个全局停止入口', async () => {
    fakeModule('agent', [COYOTE]);
    fakeModule('chat', [OPOSSUM]);

    await act(async () => {
      render(<Shell />);
    });

    expect(screen.getByText('郊狼')).toBeTruthy();
    expect(screen.getByText('负鼠')).toBeTruthy();
    expect(document.getElementById('shl-device-bar')?.textContent).toContain('82%');
    expect(screen.getAllByTitle('立刻停止全部输出（2 台设备）')).toHaveLength(1);
  });
});

it('guards desktop navigation before route or device lease changes', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => {
    render(<Shell />);
  });
  const previous = window.location.pathname;
  const remove = registerNavigationGuard(() => '未保存草稿');
  const device = within(screen.getByRole('navigation', { name: '主要功能' })).getByRole('button', {
    name: '设备',
  });
  fireEvent.click(device);
  expect(window.location.pathname).toBe(previous);
  expect(confirm).toHaveBeenCalledOnce();
  remove();
  fireEvent.click(device);
  expect(window.location.pathname).toBe('/control');
  confirm.mockRestore();
});
it('guards mobile bottom navigation before changing route', async () => {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  window.history.replaceState(null, '', '/');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  let remove = () => {};
  try {
    await act(async () => {
      render(<Shell />);
    });
    remove = registerNavigationGuard(() => '未保存草稿');
    const people = within(screen.getByRole('navigation', { name: '手机主导航' })).getByRole(
      'button',
      { name: '联系人' },
    );
    fireEvent.click(people);
    expect(window.location.pathname).toBe('/');
    remove();
    fireEvent.click(people);
    expect(window.location.pathname).toBe('/people');
  } finally {
    remove();
    cleanup();
    confirm.mockRestore();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
  }
});
