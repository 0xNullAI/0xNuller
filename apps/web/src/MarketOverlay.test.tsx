import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MarketItem } from '../../market/src/shared/schema';
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
  locked: false,
};

describe('Shell 中的 Market 弹窗', () => {
  it('使用共享 Overlay，具备对话框语义并响应 Esc', () => {
    const onClose = vi.fn();
    render(<ItemDetail item={ITEM} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: /雨夜便利店/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
