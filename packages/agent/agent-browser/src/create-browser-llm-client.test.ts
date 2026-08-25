import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderSettings } from '@0xnullai/llm-providers';
import type { LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import { createBrowserLlmClient } from './create-browser-llm-client.js';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  runTurn: vi.fn<(_: LlmTurnInput) => Promise<LlmTurnResult>>(),
}));

vi.mock('@dg-agent/providers-pi-http', () => ({
  PiAiLlmClient: class {
    readonly capabilities = { imageInput: false };

    constructor(config: unknown) {
      mocks.construct(config);
    }

    runTurn(input: LlmTurnInput) {
      return mocks.runTurn(input);
    }
  },
}));

describe('createBrowserLlmClient pi-ai loading', () => {
  beforeEach(() => {
    mocks.construct.mockClear();
    mocks.runTurn.mockReset();
  });

  it('loads the selected pi-ai runtime only when the first turn starts', async () => {
    const provider = {
      ...createProviderSettings('anthropic'),
      apiKey: 'sk-test',
      model: 'claude-test',
    };
    const result = { assistantMessage: 'ok' } satisfies LlmTurnResult;
    const input = { abortSignal: new AbortController().signal } as LlmTurnInput;
    mocks.runTurn.mockResolvedValue(result);

    const client = createBrowserLlmClient({ provider });

    expect(mocks.construct).not.toHaveBeenCalled();
    await expect(client.runTurn(input)).resolves.toEqual(result);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    expect(mocks.runTurn).toHaveBeenCalledWith(input);
  });
});
