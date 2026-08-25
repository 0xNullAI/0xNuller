import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpossumControl } from './opossum-control';

function renderControl(overrides: Partial<Parameters<typeof OpossumControl>[0]> = {}) {
  const props: Parameters<typeof OpossumControl>[0] = {
    connected: true,
    battery: 80,
    intensityA: 3,
    intensityB: 4,
    limitA: 20,
    limitB: 30,
    onAdjust: vi.fn(),
    onBurst: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<OpossumControl {...props} />) };
}

describe('OpossumControl', () => {
  it('keeps the zero-output action directly reachable', () => {
    const { props } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '归零' }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it('derives a short burst from the enforced channel limit', () => {
    const { props } = renderControl();
    fireEvent.click(screen.getAllByRole('button', { name: '脉冲' })[0]!);
    expect(props.onBurst).toHaveBeenCalledWith('A', 16, 500);
  });

  it('renders nothing while disconnected', () => {
    renderControl({ connected: false });
    expect(screen.queryByText('Opossum 振动控制器')).toBeNull();
  });
});
