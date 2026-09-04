import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { ShellChromeProvider } from '@0xnullai/ui';
import SnakeGame from './SnakeGame';
import { useSnake } from './use-snake';
vi.mock('../../use-game-device', () => ({
  useGameDevice: () => ({ pulse: vi.fn(), connected: false }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('does not consume typing in inputs, or keys after switching modules', () => {
  const view = (active: boolean) => (
    <ShellChromeProvider active={active} signedIn={false} openSettings={() => {}}>
      <SnakeGame />
      <textarea aria-label="消息" />
    </ShellChromeProvider>
  );
  const { rerender } = render(view(true));
  expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'w', cancelable: true })).toBe(true);
  expect(fireEvent.keyDown(window, { key: 'w', cancelable: true })).toBe(false);
  rerender(view(false));
  expect(fireEvent.keyDown(window, { key: 'w', cancelable: true })).toBe(true);
});
it('pauses hidden games and requires an explicit action to resume', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ active }) => useSnake({ active, random: () => 0.7 }), {
    initialProps: { active: true },
  });
  act(() => result.current.start());
  rerender({ active: false });
  expect(result.current.state.status).toBe('paused');
  const head = result.current.state.snake[0];
  act(() => vi.advanceTimersByTime(1000));
  rerender({ active: true });
  expect(result.current.state.status).toBe('paused');
  expect(result.current.state.snake[0]).toEqual(head);
  act(() => result.current.start());
  expect(result.current.state.status).toBe('running');
});
