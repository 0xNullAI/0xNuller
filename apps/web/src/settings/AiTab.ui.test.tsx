// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LlmProviders from '@0xnullai/llm-providers';
import { discoverBrowserProviderModels } from '@dg-agent/agent-browser/llm';
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
  fireEvent.click(screen.getByRole('button', { name: /^自定义模型与网络代理/ }));

  expect(screen.getByRole('switch', { name: '使用自定义模型' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(screen.getByText('接口地址')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '模型' })).toBeTruthy();
  const toggle = screen.getByRole('switch', { name: '支持图片输入' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  // The proxy settings sit on the same page, expanded.
  expect(screen.getByRole('switch', { name: '启用网络代理' })).toBeTruthy();

  fireEvent.click(toggle);
  expect(llm.save).toHaveBeenCalledWith(expect.objectContaining({ imageInput: true }));
});

it('offers only the custom endpoint as an own-API option', () => {
  llm.config = { ...llm.config, providerId: 'managed', apiKey: '', model: 'balanced' };
  render(<AiTab />);
  fireEvent.click(screen.getByRole('button', { name: /^自定义模型与网络代理/ }));

  expect(screen.queryByRole('switch', { name: '支持图片输入' })).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: '使用自定义模型' }));
  expect(llm.save).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: 'custom', apiKey: '', imageInput: false }),
  );
});

it('fills a known service from the 服务商 list and loads its models once a key is there', async () => {
  vi.mocked(discoverBrowserProviderModels).mockResolvedValue([
    'deepseek-chat',
    'deepseek-reasoner',
  ]);
  llm.config = {
    providerId: 'custom',
    apiKey: 'sk-test',
    model: 'model-name',
    baseUrl: 'https://api.deepseek.com/v1',
    endpoint: 'chat/completions',
    useStrict: false,
    imageInput: false,
    rememberApiKey: false,
  };
  render(<AiTab />);
  fireEvent.click(screen.getByRole('button', { name: /^自定义模型与网络代理/ }));

  const provider = screen.getByRole<HTMLSelectElement>('combobox', { name: '服务商' });
  expect(provider.value).toBe('deepseek');
  expect(await screen.findByText('已加载 2 个模型')).toBeTruthy();

  fireEvent.change(provider, { target: { value: 'openai' } });
  expect(llm.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ baseUrl: 'https://api.openai.com/v1', endpoint: 'responses' }),
  );
  fireEvent.change(provider, { target: { value: 'other' } });
  await waitFor(() =>
    expect(llm.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.example.com/v1' }),
    ),
  );
});

it('offers common Ark models instead of reading a list the browser cannot get', () => {
  vi.mocked(discoverBrowserProviderModels).mockClear();
  llm.config = {
    providerId: 'custom',
    apiKey: 'sk-test',
    model: 'model-name',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    endpoint: 'chat/completions',
    useStrict: false,
    imageInput: false,
    rememberApiKey: false,
  };
  render(<AiTab />);
  fireEvent.click(screen.getByRole('button', { name: /^自定义模型与网络代理/ }));
  expect(screen.queryByRole('button', { name: '刷新模型列表' })).toBeNull();
  expect(screen.getByText(/不支持在浏览器里读取模型列表/)).toBeTruthy();
  expect(discoverBrowserProviderModels).not.toHaveBeenCalled();
});
