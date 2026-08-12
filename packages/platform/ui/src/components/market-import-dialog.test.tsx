import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarketImportDialog } from './market-import-dialog';
import { Overlay } from './overlay-surface';

vi.mock('@0xnullai/market-client', () => ({
  fetchMarketItems: vi.fn().mockResolvedValue([]),
  markMarketDownloaded: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

describe('市场导入弹窗', () => {
  it('可以叠在设置层上方，并且只关闭自己', async () => {
    const closeOuter = vi.fn();
    const closeImport = vi.fn();
    render(
      <Overlay onDismiss={closeOuter}>
        <div role="dialog" aria-label="设置">
          <MarketImportDialog
            open
            onOpenChange={(open) => {
              if (!open) closeImport();
            }}
            type="scenario"
            onImport={vi.fn()}
          />
        </div>
      </Overlay>,
    );

    expect(await screen.findByRole('dialog', { name: '从市场导入场景' })).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: '从市场导入场景' });
    expect(dialog.className).toContain('max-h-[calc(var(--android-viewport-height');
    expect(dialog.className).toContain('w-full');
    fireEvent.click(screen.getByRole('button', { name: '关闭市场导入' }));

    expect(closeImport).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });
});
