import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as RoutesModule from './routes';
import { act, render, screen } from '@testing-library/react';

/**
 * 外壳的两条行为契约。
 *
 * 第二条是这次单页合并的**全部意义**：合并前四个模块是四个独立站点，切换等于整页
 * 跳转，浏览器销毁页面、BLE 连接随之断开。如果保持挂载这件事被谁改坏了，用户的
 * 感受是「切个标签设备就掉线」，而构建和类型检查都不会报错——所以用测试守住。
 */

// 用轻量假模块替换真实的四个应用：这里要验的是外壳的挂载策略，
// 不是模块内部行为（那些有各自的测试）。
vi.mock('./routes', async () => {
  const { moduleIdFromPath } = await vi.importActual<typeof RoutesModule>('./routes');
  const make = (id: string) =>
    function Fake() {
      return <div data-testid={`mod-${id}`}>{id} 已挂载</div>;
    };
  return {
    moduleIdFromPath,
    MODULES: [
      { id: 'agent', label: 'Agent', blurb: '', Component: make('agent') },
      { id: 'chat', label: 'Chat', blurb: '', Component: make('chat') },
      { id: 'voice', label: 'Voice', blurb: '', Component: make('voice') },
    ],
  };
});

const { Shell } = await import('./Shell');

function goto(path: string) {
  window.history.pushState(null, '', path);
}

beforeEach(() => {
  goto('/');
  localStorage.clear();
});

describe('统一外壳', () => {
  it('根路径显示首页，不挂载任何模块', () => {
    render(<Shell />);
    expect(screen.queryByTestId('mod-agent')).toBeNull();
    expect(screen.queryByTestId('mod-chat')).toBeNull();
  });

  it('按路径挂载对应模块', async () => {
    goto('/chat');
    render(<Shell />);
    expect(await screen.findByTestId('mod-chat')).toBeTruthy();
    // 没打开过的模块不该被挂载——不为用不到的模块付内存和连接的代价。
    expect(screen.queryByTestId('mod-voice')).toBeNull();
  });

  it('切走的模块留在 DOM 里，只是隐藏——设备连接因此不断', async () => {
    goto('/chat');
    render(<Shell />);
    const chat = await screen.findByTestId('mod-chat');

    await act(async () => {
      screen.getByRole('button', { name: 'Voice' }).click();
    });

    // Voice 挂载起来了
    expect(await screen.findByTestId('mod-voice')).toBeTruthy();
    // 而 Chat 仍然在 DOM 中——这正是「切模块不断线」的实现方式
    expect(screen.getByTestId('mod-chat')).toBe(chat);
    expect(chat.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('浏览器前进后退能驱动模块切换', async () => {
    goto('/agent');
    render(<Shell />);
    expect(await screen.findByTestId('mod-agent')).toBeTruthy();

    await act(async () => {
      goto('/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByTestId('mod-chat')).toBeTruthy();
  });
});
