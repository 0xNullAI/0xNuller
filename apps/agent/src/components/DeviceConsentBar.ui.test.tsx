// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { deviceConversationAccess, setDeviceConversationAccess } from '@0xnullai/settings';
import { DeviceConsentBar } from './DeviceConsentBar.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('writes the same per-chat consent the settings page and execution gate read', () => {
  render(<DeviceConsentBar accountId="alice" conversationId="chat-1" deviceConnected />);
  expect(screen.getByText('允许本聊天控制设备？')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '允许' }));
  expect(deviceConversationAccess('alice', 'ai', 'chat-1')).toBe(true);
  expect(deviceConversationAccess('alice', 'ai', 'chat-2')).toBe(false);
  expect(screen.queryByText('允许本聊天控制设备？')).toBeNull();
  // Revoking from settings brings the bar back.
  act(() => {
    setDeviceConversationAccess('alice', 'ai', 'chat-1', false);
  });
  expect(screen.getByRole('button', { name: '允许' })).toBeTruthy();
});

it('stays hidden without a connected device or a saved conversation', () => {
  const { rerender } = render(
    <DeviceConsentBar accountId="alice" conversationId="chat-1" deviceConnected={false} />,
  );
  expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
  rerender(<DeviceConsentBar accountId={null} conversationId="chat-1" deviceConnected />);
  expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
  rerender(<DeviceConsentBar accountId="alice" conversationId={null} deviceConnected />);
  expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
});
