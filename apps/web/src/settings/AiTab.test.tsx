import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { AiTab } from './AiTab';

describe('统一 AI 设置', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('在文本模型卡片内直接写入 Agent 实际使用的模型行为设置', () => {
    render(<AiTab />);
    const textModel = screen.getByRole('heading', { name: '文本模型' }).closest('section');
    expect(textModel).not.toBeNull();
    expect(textModel?.contains(screen.getByText('上下文策略'))).toBe(true);
    expect(textModel?.contains(screen.getByText('回复多样性'))).toBe(true);
    expect(screen.getByText(/不随账户同步/)).toBeTruthy();

    fireEvent.change(screen.getByRole('slider', { name: '回复多样性' }), {
      target: { value: '0.55' },
    });
    const actual = new BrowserAppSettingsStore().loadModelBehavior();
    expect(actual.temperature).toBe(0.55);
    expect(actual.modelContextStrategy).toBe('last-five-user-turns');
  });
});
