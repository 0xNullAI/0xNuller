// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LlmProviders from '@0xnullai/llm-providers';
import { AiTab } from './AiTab';

const llm = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('@0xnullai/llm-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmProviders>();
  const model = (id: string, toolCall: boolean, releaseDate: string) => ({
    id,
    name: id.toUpperCase(),
    family: null,
    image: false,
    reasoning: false,
    temperature: true,
    toolCall,
    context: null,
    output: null,
    releaseDate,
  });
  return {
    ...actual,
    loadLlmConfig: () => ({
      providerId: 'openai',
      apiKey: 'sk-test',
      model: '',
      baseUrl: 'https://api.openai.com/v1',
      endpoint: 'chat/completions',
      useStrict: false,
      rememberApiKey: false,
    }),
    saveLlmConfig: llm.save,
    subscribeLlmConfig: () => () => undefined,
    subscribeModelCatalog: () => () => undefined,
    getModelCatalogVersion: () => 1,
    getCatalogModels: () => [
      model('gpt-old', true, '2025-01-01'),
      model('gpt-no-tools', false, '2026-09-01'),
      model('gpt-new', true, '2026-05-01'),
    ],
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
vi.mock('./VoiceProviderSection', () => ({
  VoiceProviderSection: () => <div>语音服务商</div>,
  VoiceTimbreField: () => <div>音色</div>,
}));
vi.mock('./VideoProviderSection', () => ({ VideoProviderSection: () => <div>视觉服务商</div> }));

afterEach(() => {
  cleanup();
  llm.save.mockClear();
});

it('offers the newest tool-calling model as a suggestion and saves it only when clicked', () => {
  render(<AiTab />);
  expect(screen.queryByRole('combobox', { name: '模型' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '高级' }));

  // Catalog providers keep their preset address; only the custom provider shows it.
  expect(screen.queryByText('接口地址')).toBeNull();
  const field = screen.getByRole('combobox', { name: '模型' });
  expect(field.getAttribute('placeholder')).toBe('搜索或输入模型 ID');
  fireEvent.focus(field);

  const options = screen.getAllByRole('option');
  expect(options[0]?.textContent).toContain('推荐');
  expect(options[0]?.textContent).toContain('GPT-NEW');
  expect(options[0]?.textContent).toContain('点击确认');
  expect((field as HTMLInputElement).value).toBe('');
  expect(llm.save).not.toHaveBeenCalled();

  fireEvent.click(options[0]!);
  expect(llm.save).toHaveBeenCalledTimes(1);
  expect(llm.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-new' }));
});
