import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from './dialog';

afterEach(cleanup);

describe('共享 Dialog', () => {
  it('关闭按钮在窄屏使用 44px 触控尺寸，并保留可读名称', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>示例弹窗</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const close = screen.getByRole('button', { name: '关闭' });
    expect(close.className).toContain('h-11');
    expect(close.className).toContain('w-11');

    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
