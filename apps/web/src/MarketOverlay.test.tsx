import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShellChromeProvider } from '@0xnullai/ui';
import type { MarketItem } from '../../market/src/shared/schema';
import { App as MarketApp } from '../../market/src/web/App';
import { ItemDetail } from '../../market/src/web/components/ItemDetail';

afterEach(cleanup);

const ITEM: MarketItem = {
  id: 'scene-1',
  type: 'scenario',
  name: '雨夜便利店',
  description: '场景简介',
  tags: ['都市'],
  content: { prompt: '场景提示词' },
  views: 3,
  downloads: 1,
  createdAt: Date.UTC(2026, 0, 1),
};

describe('Shell 中的 Market 弹窗', () => {
  it('使用共享 Overlay，具备对话框语义并响应 Esc', () => {
    const onClose = vi.fn();
    render(<ItemDetail item={ITEM} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: /雨夜便利店/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('未登录时上传入口直接打开账户设置，不让用户填完表单才失败', () => {
    const openSettings = vi.fn();
    render(
      <ShellChromeProvider openSettings={openSettings} signedIn={false}>
        <MarketApp />
      </ShellChromeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    expect(openSettings).toHaveBeenCalledWith('account');
    expect(screen.queryByRole('dialog', { name: '上传内容' })).toBeNull();
  });
});
