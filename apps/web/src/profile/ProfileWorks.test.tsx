import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfileWorks } from './ProfileWorks';

const market = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@0xnullai/market-client', () => ({ fetchCreatorMarketItems: market.fetch }));
afterEach(() => {
  cleanup();
  market.fetch.mockReset();
});

it('shows only verified public works and opens Market in the current shell', async () => {
  market.fetch.mockResolvedValue([
    { id: 'role-1', type: 'scenario', name: '林', icon: '🌿', content: { kind: 'character' } },
    { id: 'wave-1', type: 'waveform', name: '雨声' },
  ]);
  const onOpen = vi.fn();
  render(<ProfileWorks creatorId="alice" viewerId="viewer" onOpen={onOpen} />);
  const role = await screen.findByRole('link', { name: /林/ });
  expect(role.getAttribute('href')).toBe('/market?item=role-1');
  fireEvent.click(role);
  expect(onOpen).toHaveBeenCalledWith('role-1');
  expect(screen.getByText('角色')).toBeTruthy();
  expect(screen.getByText('波形')).toBeTruthy();
  expect(market.fetch).toHaveBeenCalledWith('alice', 'viewer', expect.any(AbortSignal));
});
