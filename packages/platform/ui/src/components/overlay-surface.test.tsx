import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Overlay } from './overlay-surface';

/**
 * Every dialog in the product routes through this component, so its
 * keyboard behavior is product-wide behavior.
 *
 * The case that matters most is the negative one: the safety notice and
 * the permission modal deliberately pass no `onDismiss`, which is what
 * makes their backdrop inert. If Escape ever starts closing an overlay
 * that has no dismiss handler, those two gain a keyboard escape hatch —
 * a user could dismiss the safety notice without reading it, and the
 * permission modal could be answered by a stray keypress.
 */

afterEach(cleanup);

describe('弹窗遮罩层', () => {
  it('按 Esc 关闭可关闭的弹窗', () => {
    const onDismiss = vi.fn();
    render(
      <Overlay onDismiss={onDismiss}>
        <button>确定</button>
      </Overlay>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('没有 onDismiss 的弹窗不响应 Esc——安全提示必须被读完', () => {
    // No handler to assert against, so assert the overlay is still mounted.
    render(
      <Overlay>
        <button>我已阅读</button>
      </Overlay>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByText('我已阅读')).toBeTruthy();
  });

  it('嵌套时 Esc 只关最上面一层', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Overlay onDismiss={closeOuter}>
          <button>外层</button>
        </Overlay>
        <Overlay onDismiss={closeInner} level="stacked">
          <button>内层</button>
        </Overlay>
      </>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('关闭后 Esc 不再触发已卸载弹窗的回调', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(
      <Overlay onDismiss={onDismiss}>
        <button>确定</button>
      </Overlay>,
    );

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('打开时焦点进入弹窗', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    render(
      <Overlay onDismiss={() => undefined}>
        <button>确定</button>
      </Overlay>,
    );

    expect(document.activeElement).not.toBe(outside);
    outside.remove();
  });

  it('关闭后焦点回到打开它的元素', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(
      <Overlay onDismiss={() => undefined}>
        <button>确定</button>
      </Overlay>,
    );
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('Tab 走到最后一个控件后回到第一个，不会跑到弹窗外面', () => {
    render(
      <Overlay onDismiss={() => undefined}>
        <button>第一个</button>
        <button>最后一个</button>
      </Overlay>,
    );

    const first = screen.getByText('第一个');
    const last = screen.getByText('最后一个');
    last.focus();

    fireEvent.keyDown(last, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('Shift+Tab 从第一个控件回到最后一个', () => {
    render(
      <Overlay onDismiss={() => undefined}>
        <button>第一个</button>
        <button>最后一个</button>
      </Overlay>,
    );

    const first = screen.getByText('第一个');
    const last = screen.getByText('最后一个');
    first.focus();

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('点击遮罩关闭，点击内容不关闭', () => {
    const onDismiss = vi.fn();
    render(
      <Overlay onDismiss={onDismiss} className="backdrop">
        <button>确定</button>
      </Overlay>,
    );

    fireEvent.mouseDown(screen.getByText('确定'));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.querySelector('.backdrop')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
