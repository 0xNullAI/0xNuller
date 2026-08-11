import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OverlayProvider } from '../overlay';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('SettingSelect overlay interaction', () => {
  it('keeps portaled options interactive inside the shell pointer-events-none root', () => {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: MouseEvent,
    });
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
    const overlay = document.createElement('div');
    overlay.style.pointerEvents = 'none';
    document.body.appendChild(overlay);
    const onChange = vi.fn();
    render(
      <OverlayProvider container={overlay}>
        <Select defaultOpen defaultValue="medium" onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="medium">最近 5 轮</SelectItem>
            <SelectItem value="full">完整对话</SelectItem>
          </SelectContent>
        </Select>
      </OverlayProvider>,
    );

    const listbox = screen.getByRole('listbox');
    expect(listbox.className).toContain('pointer-events-auto');
    fireEvent.click(screen.getByRole('option', { name: '完整对话' }));
    expect(onChange).toHaveBeenCalledWith('full');
    overlay.remove();
  });
});
