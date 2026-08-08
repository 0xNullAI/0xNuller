import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  grantDeviceLease,
  hasDeviceLease,
  registerSafetySession,
  type DeviceSummary,
} from '@dg-kit/safety';
import { Shell } from './Shell';

/**
 * 切换模块时设备控制权真的转手了吗。
 *
 * 租约本身的行为在 `@dg-kit/safety` 的 device-lease / safety-chain 测试里已经验过。
 * 这里验的是**外壳有没有去调它**——上一轮的教训正是这个：`registerSafetySession`
 * 的逻辑完全正确，测试全绿，但全仓没有一个调用者，全局停止按钮从未渲染过。
 *
 * 逻辑正确而没人调用，是这类契约最容易出现、也最难从单测里看出来的失效方式。
 */

// 模块是懒加载的真实应用，在 jsdom 里跑不起来（BLE、Worker、音频）。
// 这里关心的只是「路由变了之后外壳做了什么」，所以把四个模块换成占位。
vi.mock('./routes', async () => {
  const { lazy } = await import('react');
  const stub = (label: string) =>
    lazy(() => Promise.resolve({ default: () => <div>{label} 模块</div> }));
  return {
    MODULES: [
      { id: 'agent', label: 'Agent', blurb: '', Component: stub('Agent') },
      { id: 'chat', label: 'Chat', blurb: '', Component: stub('Chat') },
    ],
    moduleIdFromPath: (p: string) => {
      const id = p.replace(/^\//, '');
      return id === 'agent' || id === 'chat' ? id : null;
    },
  };
});

// 账号服务在测试里不可达；未登录是它的正常兜底路径。
vi.mock('@0xnullai/auth', () => ({
  me: () => Promise.resolve(null),
  logout: () => Promise.resolve(),
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

    // 走真实的导航路径（外壳的 pushState + popstate 同步），不是直接调 grantDeviceLease
    // ——被测的就是「外壳有没有在路由变化时调它」。
    await act(async () => {
      window.history.pushState(null, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(hasDeviceLease('chat')).toBe(true);
    expect(hasDeviceLease('agent')).toBe(false);
    // 切走的模块必须收到通知去停输出、清掉「按住不放」的聚合状态。
    // 只把租约标志翻掉是不够的：远程指令不经过 UI。
    expect(agent.onRevoke).toHaveBeenCalled();
  });

  it('回到首页时没有任何模块持有租约，但停止按钮还在', async () => {
    fakeModule('agent', [COYOTE]);
    await act(async () => {
      render(<Shell />);
    });

    await act(async () => {
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(hasDeviceLease('agent')).toBe(false);
    // 首页是最容易漏的一处：把设备栏当成「模块的一部分」渲染，回到首页它就消失了
    // ——而设备还连在人身上，此时停止按钮反而最该在。
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
  });

  it('设备栏与停止按钮不随模块切换消失——设备还连着', async () => {
    fakeModule('agent', [COYOTE]);
    fakeModule('chat', []);

    await act(async () => {
      render(<Shell />);
    });
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();

    await act(async () => {
      window.history.pushState(null, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // 交出控制权不等于断开设备。设备还在人身上，停止按钮就必须还在。
    expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy();
  });
});
