// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MemberState } from '../lib/protocol';
import { ControlPanel } from './ControlPanel';

const self = {
  peerId: 'self',
  displayName: '我',
  deviceConnected: false,
  strengthA: 0,
  strengthB: 0,
  waveA: null,
  waveB: null,
  battery: null,
  queueA: [],
  queueB: [],
} as unknown as MemberState;

function renderPanel() {
  render(
    <ControlPanel
      members={new Map()}
      peers={[]}
      onSendCommand={vi.fn()}
      onSendWaveform={vi.fn()}
      roomId="123456"
      waveforms={[]}
      onImportWaveform={vi.fn(async () => null)}
      onImportMarketWaveform={vi.fn()}
      onRemoveWaveform={vi.fn()}
      selfState={self}
      selfLimitA={50}
      selfLimitB={50}
      isPublic={false}
      canManage={false}
      onSetPublic={vi.fn()}
      roomName="群"
      onRename={vi.fn()}
      onCloseRoom={vi.fn()}
    />,
  );
}

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
});

it('confirms a copied invite link', async () => {
  stubClipboard(vi.fn(async () => undefined));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '复制邀请链接' }));
  expect(await screen.findByText('已复制')).toBeTruthy();
});

it('tells the user when the clipboard refuses the invite link', async () => {
  vi.useFakeTimers();
  stubClipboard(vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '复制邀请链接' }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByRole('alert').textContent).toBe('复制失败，请手动复制群号');
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole('alert')).toBeNull();
});
