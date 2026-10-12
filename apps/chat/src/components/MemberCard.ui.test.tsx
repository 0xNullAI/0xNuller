import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemberCard } from './MemberCard';
import type { MemberState } from '../lib/protocol';

vi.mock('./ProfileAvatar', () => ({ ProfileAvatar: () => null }));
afterEach(cleanup);

const member = (deviceAccess: boolean | undefined) =>
  ({
    peerId: 'bob',
    displayName: 'Bob',
    deviceConnected: true,
    strengthA: 3,
    strengthB: 4,
    battery: 80,
    deviceAccess,
  }) as MemberState;

it('says when a connected member has not let this chat control their device', () => {
  const view = render(<MemberCard peerId="bob" member={member(false)} onClick={vi.fn()} />);
  expect(screen.getByText('未授权控制')).toBeTruthy();
  // Older clients do not report it; their own device still decides, so nothing is claimed.
  for (const access of [true, undefined]) {
    view.rerender(<MemberCard peerId="bob" member={member(access)} onClick={vi.fn()} />);
    expect(screen.queryByText('未授权控制')).toBeNull();
  }
});
