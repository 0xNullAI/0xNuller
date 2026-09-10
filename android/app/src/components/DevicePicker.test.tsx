// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DevicePicker } from './DevicePicker';

describe('DevicePicker', () => {
  it('explains one-device and two-Coyote connection flows', () => {
    render(
      <DevicePicker open devices={[]} scanning={false} onSelect={vi.fn()} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText('连接帮助'));
    expect(screen.getByText(/只连接一台/)).toBeTruthy();
    expect(screen.getByText(/连接两台郊狼/)).toBeTruthy();
  });
});
