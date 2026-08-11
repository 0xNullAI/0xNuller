import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Dialog, DialogContent } from './components/dialog';
import { Sheet, SheetContent } from './components/sheet';
import { Z_OVERLAY, Z_OVERLAY_PANEL } from './z-layers';

/**
 * Guards a bug that already shipped once.
 *
 * The backdrop was moved onto the z token (100) while the panel kept a
 * hand-written `z-50`. They are position:fixed siblings in one portal, so
 * the backdrop painted over the panel: the page dimmed and blurred with no
 * dialog visible, and Radix closed it on the next click. Build, typecheck,
 * lint and every existing test stayed green — jsdom does not do stacking,
 * and the class strings look fine read one at a time.
 *
 * So these assert the relationship between the two, which is the thing
 * that was actually wrong.
 */

afterEach(cleanup);

function zIndexOf(className: string): number | null {
  const m = className.match(/z-\[([^\]]+)\]/);
  if (!m) return null;
  const expr = m[1]!.replace(/var\(--z-module-overlay\)/g, '100');
  const calc = expr.match(/^calc\((.+)\)$/);
  const body = calc ? calc[1]! : expr;
  const sum = body.match(/^(\d+)\s*\+\s*(\d+)$/);
  if (sum) return Number(sum[1]) + Number(sum[2]);
  return /^\d+$/.test(body) ? Number(body) : null;
}

describe('弹窗层级', () => {
  it('令牌本身：面板压过遮罩', () => {
    const overlay = zIndexOf(Z_OVERLAY);
    const panel = zIndexOf(Z_OVERLAY_PANEL);
    expect(overlay).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!).toBeGreaterThan(overlay!);
  });

  it('Dialog 的内容层压过它自己的遮罩', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    const zs = [...baseElement.querySelectorAll<HTMLElement>('*')]
      .map((n) => zIndexOf(typeof n.className === 'string' ? n.className : ''))
      .filter((z): z is number => z !== null);

    // Backdrop and panel are the two fixed layers; the panel must be last.
    expect(zs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...zs)).toBe(zIndexOf(Z_OVERLAY_PANEL));
  });

  it('Sheet 的内容层压过它自己的遮罩', () => {
    const { baseElement } = render(
      <Sheet open>
        <SheetContent>内容</SheetContent>
      </Sheet>,
    );

    const zs = [...baseElement.querySelectorAll<HTMLElement>('*')]
      .map((n) => zIndexOf(typeof n.className === 'string' ? n.className : ''))
      .filter((z): z is number => z !== null);

    expect(zs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...zs)).toBe(zIndexOf(Z_OVERLAY_PANEL));
  });

  it('没有裸 z-50 残留——那正是当初写坏的写法', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    expect(baseElement.querySelector('.z-50')).toBeNull();
  });
});
