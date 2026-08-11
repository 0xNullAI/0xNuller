import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './avatar';

/**
 * The rule under test is a product constraint, not a styling detail.
 *
 * Most people in a room have no account — anonymous use is a hard constraint —
 * and their avatar must not be a link to a profile that does not exist. The
 * guard lives inside this component precisely so that no call site can forget
 * it, and these tests are what stop somebody "simplifying" it back out.
 */

afterEach(cleanup);

describe('头像', () => {
  it('有账号时可以点开主页，回传的是用户名', () => {
    const onOpenProfile = vi.fn();
    render(<Avatar name="小明" username="xiaoming" onOpenProfile={onOpenProfile} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenProfile).toHaveBeenCalledWith('xiaoming');
  });

  it('点头像不会连带触发外层可点区域', () => {
    // Chat 的成员行点开的是那个人的设备控制面板。一次点击同时打开主页和那个面板，
    // 等于把用户送到一个他没有要求去的、能驱动电流的界面。
    const onRow = vi.fn();
    const onOpenProfile = vi.fn();
    render(
      <div onClick={onRow}>
        <Avatar name="小明" username="xiaoming" onOpenProfile={onOpenProfile} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
  });

  it('没有账号的房间成员完全不可点', () => {
    const onOpenProfile = vi.fn();
    const { container } = render(<Avatar name="路人" onOpenProfile={onOpenProfile} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('路');
  });

  it('空字符串用户名同样不可点——不能变成一次空查询', () => {
    render(<Avatar name="路人" username="   " onOpenProfile={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('没有传回调时即使有账号也只是图形', () => {
    render(<Avatar name="小明" username="xiaoming" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('同一个账号改了昵称也还是同一张脸', () => {
    // The pattern is generated from the account handle, so a rename does not
    // hand somebody a new identity in the member list.
    const first = render(<Avatar name="旧名字" username="same" />).container.innerHTML;
    cleanup();
    const second = render(<Avatar name="新名字" username="same" />).container.innerHTML;
    const background = (html: string) => /linear-gradient\([^)]*\)[^"]*/.exec(html)?.[0];
    expect(background(first)).toBe(background(second));
  });

  it('完全没有名字时是占位符而不是空白', () => {
    const { container } = render(<Avatar name={null} />);
    expect(container.textContent).toBe('?');
  });

  it('有账户图片时显示图片，仍保留生成头像的无图回退', () => {
    render(<Avatar name="小明" username="xiaoming" src="/avatar.png" />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/avatar.png');
  });
});
