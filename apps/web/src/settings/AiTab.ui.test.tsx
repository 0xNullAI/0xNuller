// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LlmProviders from '@0xnullai/llm-providers';
import { AiTab } from './AiTab';

const llm = vi.hoisted(() => ({
  save: vi.fn(),
  config: {
    providerId: 'custom',
    apiKey: 'sk-test',
    model: 'my-model',
    baseUrl: 'https://api.example.org/v1',
    endpoint: 'chat/completions',
    useStrict: false,
    imageInput: false,
    rememberApiKey: false,
  } as Record<string, unknown>,
}));

vi.mock('@0xnullai/llm-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmProviders>();
  return {
    ...actual,
    loadLlmConfig: () => llm.config,
    saveLlmConfig: llm.save,
    subscribeLlmConfig: () => () => undefined,
  };
});
vi.mock('@dg-agent/storage-browser', () => ({
  BrowserAppSettingsStore: class {
    loadModelBehavior() {
      return { modelContextStrategy: 'last-five-user-turns', temperature: 0.5 };
    }
    saveModelBehavior(value: unknown) {
      return value;
    }
    subscribeModelBehavior() {
      return () => undefined;
    }
  },
}));
vi.mock('@dg-agent/agent-browser/llm', () => ({
  discoverBrowserProviderModels: vi.fn(),
  testBrowserProviderConnection: vi.fn(),
}));
vi.mock('./VoiceTimbreField', () => ({ VoiceTimbreField: () => <div>音色</div> }));
vi.mock('./VideoProviderSection', () => ({ VideoProviderSection: () => <div>视觉服务商</div> }));

afterEach(() => {
  cleanup();
  llm.save.mockClear();
});

it('shows the custom endpoint with image input off until the user switches it on', () => {
  render(<AiTab />);
  fireEvent.click(screen.getByRole('button', { name: /^使用自己的 API/ }));

  expect(screen.getByText('接口地址')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '模型' })).toBeTruthy();
  const toggle = screen.getByRole('checkbox', { name: '支持图片输入' }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);

  fireEvent.click(toggle);
  expect(llm.save).toHaveBeenCalledWith(expect.objectContaining({ imageInput: true }));
});

it('offers only the custom endpoint as an own-API option', () => {
  llm.config = { ...llm.config, providerId: 'managed', apiKey: '', model: 'balanced' };
  render(<AiTab />);
  fireEvent.click(screen.getByRole('button', { name: /^使用自己的 API/ }));

  expect(screen.queryByRole('checkbox', { name: '支持图片输入' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '使用自定义接口' }));
  expect(llm.save).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: 'custom', apiKey: '', imageInput: false }),
  );
});
