import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmButton } from './confirm-button';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('runs only on a second press, and disarms by itself', () => {
  vi.useFakeTimers();
  const onConfirm = vi.fn();
  render(
    <ConfirmButton onConfirm={onConfirm} confirmLabel="再点一次确认">
      删除
    </ConfirmButton>,
  );
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(onConfirm).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(5000));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(screen.getByRole('button', { name: '再点一次确认' }));
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
});
