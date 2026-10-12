// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeHealthPanel } from './RuntimeHealthPanel';

const api = vi.hoisted(() => ({ getAdminRuntimeHealth: vi.fn() }));
vi.mock('@0xnullai/auth', () => api);
vi.mock('@0xnullai/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

afterEach(cleanup);

describe('runtime health panel', () => {
  it('shows server counts per Worker and top client signatures', async () => {
    api.getAdminRuntimeHealth.mockResolvedValue({
      generatedAt: 1,
      since: 0,
      server: [{ worker: 'llm-proxy', http5xx: 7, exceptions: 1, scheduled: 0, lastSeenAt: 1 }],
      clientTotal: 12,
      signatures: [
        {
          signature: 's',
          kind: 'error',
          message: 'TypeError: x is undefined',
          topFrame: null,
          moduleId: 'agent',
          platform: 'android',
          version: '7.0.0',
          count: 12,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    });
    render(<RuntimeHealthPanel />);
    expect(await screen.findByText('LLM Proxy')).toBeTruthy();
    expect(screen.getByText(/5xx 7 · 异常 1/)).toBeTruthy();
    expect(screen.getByText('TypeError: x is undefined')).toBeTruthy();
    expect(screen.getByText(/agent · android 7\.0\.0/)).toBeTruthy();
  });

  it('reports a load failure', async () => {
    api.getAdminRuntimeHealth.mockRejectedValue(new Error('无管理权限'));
    render(<RuntimeHealthPanel />);
    expect(await screen.findByText('无管理权限')).toBeTruthy();
  });
});
