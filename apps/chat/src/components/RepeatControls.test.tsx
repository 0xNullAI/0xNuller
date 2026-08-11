import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepeatButton } from './RepeatControls';

afterEach(() => {
  vi.useRealTimers();
});

describe('长按强度按钮', () => {
  it('触摸被系统取消后立即停止重复，不再继续发强度命令', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const { getByRole } = render(<RepeatButton onAction={action}>+</RepeatButton>);
    const button = getByRole('button');

    fireEvent.pointerDown(button);
    vi.advanceTimersByTime(500);
    expect(action.mock.calls.length).toBeGreaterThan(1);

    fireEvent.pointerCancel(button);
    const stoppedAt = action.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(action).toHaveBeenCalledTimes(stoppedAt);
  });
});
