import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SnakeGame from './SnakeGame';

vi.mock('../../use-game-device', () => ({
  useGameDevice: () => ({ connected: false, pulse: vi.fn() }),
}));

describe('贪吃蛇交互', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('点击开始后游戏会推进', () => {
    render(<SnakeGame />);

    const initialHead = document.querySelectorAll('[role="grid"] > div')[8 * 17 + 8];
    expect(initialHead?.className).toContain('bg-[var(--accent)]');

    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    act(() => vi.advanceTimersByTime(140));

    const movedHead = document.querySelectorAll('[role="grid"] > div')[8 * 17 + 9];
    expect(movedHead?.className).toContain('bg-[var(--accent)]');
  });

  it('方向键可直接启动，并阻止页面滚动', () => {
    render(<SnakeGame />);

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);

    act(() => vi.advanceTimersByTime(140));
    const movedHead = document.querySelectorAll('[role="grid"] > div')[9 * 17 + 8];
    expect(movedHead?.className).toContain('bg-[var(--accent)]');
  });

  it('提供可点按且有无障碍名称的四向控制', () => {
    render(<SnakeGame />);

    for (const name of ['向上', '向下', '向左', '向右']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole('button', { name: '向左' }));
    act(() => vi.advanceTimersByTime(140));
    const movedHead = document.querySelectorAll('[role="grid"] > div')[8 * 17 + 7];
    expect(movedHead?.className).toContain('bg-[var(--accent)]');
  });
});
