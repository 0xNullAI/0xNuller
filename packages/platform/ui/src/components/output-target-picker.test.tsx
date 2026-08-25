// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputTargetPicker } from './output-target-picker';

afterEach(cleanup);

describe('OutputTargetPicker', () => {
  it('selects and disconnects exact unified output identities', () => {
    const onSelect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <OutputTargetPicker
        targets={[
          {
            id: 'coyote/one',
            kind: 'coyote',
            label: '郊狼 · One',
            battery: 80,
            active: true,
          },
          {
            id: 'embedded/device/motor',
            kind: 'embedded',
            label: '通用设备 · Motor',
            battery: null,
            active: false,
          },
        ]}
        selectedId="coyote/one"
        onSelect={onSelect}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: '输出设备' }), {
      target: { value: 'embedded/device/motor' },
    });
    fireEvent.click(screen.getByRole('button', { name: '断开 郊狼 · One' }));

    expect(onSelect).toHaveBeenCalledWith('embedded/device/motor');
    expect(onDisconnect).toHaveBeenCalledWith('coyote/one');
  });

  it('renders a disabled empty state when no output is connected', () => {
    render(<OutputTargetPicker targets={[]} selectedId="" onSelect={vi.fn()} />);
    const picker = screen.getByRole('combobox', { name: '输出设备' });
    expect(picker).toHaveProperty('disabled', true);
    expect(picker.textContent).toContain('暂无已连接输出');
  });
});
