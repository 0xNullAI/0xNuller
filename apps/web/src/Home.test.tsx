import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('首页模块导航', () => {
  it('用有标题的语义分组呈现全部模块', () => {
    render(<Home onOpen={vi.fn()} />);

    const navigation = screen.getByRole('navigation', { name: '功能模块' });
    expect(within(navigation).getByRole('heading', { name: '控制与协作' })).toBeTruthy();
    expect(within(navigation).getByRole('heading', { name: '连接与探索' })).toBeTruthy();
    expect(within(navigation).getAllByRole('button')).toHaveLength(7);
    expect(screen.getByRole('heading', { level: 1, name: '0xNuller' })).toBeTruthy();
  });

  it('卡片保持原有模块导航行为', () => {
    const onOpen = vi.fn();
    render(<Home onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: /Control/ }));
    expect(onOpen).toHaveBeenCalledWith('control');
  });

  it('回访状态在一次挂载期间保持稳定', () => {
    localStorage.setItem('0xnullai-visited', '1');
    render(<Home onOpen={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: '欢迎回来' })).toBeTruthy();
    expect(screen.getByText('继续使用共用设备、安全设置和波形库。')).toBeTruthy();
  });
});
