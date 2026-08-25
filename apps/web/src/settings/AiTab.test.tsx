import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { AiTab } from './AiTab';
import {
  defaultLlmConfig,
  defaultVideoLlmConfig,
  loadVideoLlmConfig,
  saveLlmConfig,
  saveVideoLlmConfig,
} from '@0xnullai/llm-providers';

describe('统一 AI 设置', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
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

  it('在 Agent、Voice、Video 之间切换且默认保持现有 Agent 设置', () => {
    render(<AiTab />);
    const agentTab = screen.getByRole('tab', { name: 'Agent' });
    expect(agentTab.getAttribute('aria-selected')).toBe('true');
    expect(agentTab.getAttribute('aria-controls')).toBe('ai-agent-panel');
    expect(screen.getByRole('heading', { name: '文本模型' })).toBeTruthy();

    fireEvent.keyDown(agentTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Voice' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Voice' }));
    expect(screen.getByRole('heading', { name: '语音模型' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Voice' }));
    expect(screen.getByRole('heading', { name: '语音模型' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    expect(screen.getByRole('heading', { name: 'Video 视觉模型' })).toBeTruthy();
    expect(screen.getByText('API 密钥')).toBeTruthy();
    expect(screen.queryByText('Video API 密钥')).toBeNull();
  });

  it('Agent 设置变更不会改写 Video 配置', () => {
    saveVideoLlmConfig({
      ...defaultVideoLlmConfig(),
      apiKey: 'video-key',
      model: 'gpt-4o-mini',
    });
    render(<AiTab />);
    fireEvent.change(screen.getByRole('slider', { name: '回复多样性' }), {
      target: { value: '0.8' },
    });
    expect(loadVideoLlmConfig()).toMatchObject({ apiKey: 'video-key', model: 'gpt-4o-mini' });
  });

  it('清楚标记持久化的不受支持 Video 模型且不把它列为选项', () => {
    saveVideoLlmConfig({
      ...defaultVideoLlmConfig(),
      apiKey: 'video-key',
      model: 'gpt-4o-private-preview',
    });
    render(<AiTab initialSection="video" />);
    expect(screen.getByRole('alert').textContent).toContain('未被明确标记为支持图片输入');
    expect(screen.getByRole('combobox', { name: 'Video 视觉模型' }).textContent).not.toContain(
      'gpt-4o-private-preview',
    );
    expect(screen.getByText(/无法开始视觉解释/)).toBeTruthy();
  });

  it('restores provider discovery and OpenAI-compatible controls', () => {
    saveLlmConfig({
      ...defaultLlmConfig(),
      providerId: 'custom',
      baseUrl: 'https://example.com/v1',
      model: 'model-x',
    });
    render(<AiTab />);
    expect(screen.getByRole('textbox', { name: '搜索服务商' })).toBeTruthy();
    expect(screen.getByText(/OpenAI 兼容后端/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新模型列表' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeTruthy();
    expect(screen.getByText('在当前设备记住 API 密钥')).toBeTruthy();
    expect(
      screen.getByText('接口类型').parentElement?.querySelector('[role="combobox"]'),
    ).toBeTruthy();
    expect(
      screen.getByText('严格 Schema').parentElement?.querySelector('[role="combobox"]'),
    ).toBeTruthy();
  });
});
