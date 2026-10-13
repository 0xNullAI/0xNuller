import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetSceneSyncForTests, loadScenes, saveScenes } from './index.js';
import { ScriptSplitterDialog } from './script-splitter-dialog.js';
import type { ScriptSource } from './script-splitter.js';

const auth = vi.hoisted(() => ({ account: 'alice' as string | null }));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
}));
vi.mock('@0xnullai/sync', () => ({
  pullContent: vi.fn().mockResolvedValue(null),
  pullContentPreferences: vi.fn().mockResolvedValue(null),
  pushContent: vi.fn().mockResolvedValue(true),
  pushContentPreferences: vi.fn().mockResolvedValue(true),
}));

const source: ScriptSource = {
  name: '雾港',
  prompt: '雾港剧本。'.repeat(1000),
  author: '@writer',
  derivedFrom: { itemId: 'item-1', name: '雾港' },
};

const outline = {
  scene: { name: '雾港', summary: '常年起雾的港口城市。', rules: '入夜后不能出海。', cast: [] },
  characters: [
    { name: '林雾', oneLine: '灯塔看守', isMain: true },
    { name: '老周', oneLine: '酒馆老板', isMain: false },
  ],
};

const character = {
  name: '林雾',
  summary: '守灯塔的成年女人',
  description: '背景'.repeat(100),
  personality: '冷静'.repeat(40),
  situation: '你在雾里迷路。',
  boundaries: '你说停就停\n不替你说话或决定',
  greeting: '这么大的雾，你怎么还在外面？',
  exampleDialogue: '你：这里是哪？\n林雾：灯塔。外面雾大，先进来暖暖身子。',
  tags: ['悬疑'],
};

const fetchMock = vi.fn();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content: string) => json(200, { choices: [{ message: { content } }] });
const catalog = () =>
  json(200, {
    data: [{ id: 'balanced', inputCreditsPerMillion: 1500, outputCreditsPerMillion: 6000 }],
    credit: { available: 500 },
  });

beforeEach(() => {
  auth.account = 'alice';
  localStorage.clear();
  __resetSceneSyncForTests();
  saveScenes({ scenes: [], selectedId: '', hiddenBuiltinIds: [] });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('estimates, outlines, lets the user pick, and saves private cards', async () => {
  fetchMock
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(completion(`好的\n\`\`\`json\n${JSON.stringify(outline)}\n\`\`\``))
    .mockResolvedValueOnce(completion(JSON.stringify(character)));
  const onStartChat = vi.fn();
  const onClose = vi.fn();
  render(<ScriptSplitterDialog source={source} onClose={onClose} onStartChat={onStartChat} />);

  expect(await screen.findByText(/预计约 \d+ Credit（按实际用量扣费） · 余额 500/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '开始整理' }));

  const main = await screen.findByRole('checkbox', { name: '林雾' });
  expect(main.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('checkbox', { name: '老周' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('checkbox', { name: '同时保存场景' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toMatch(/\/v1\/chat\/completions$/);
  expect(init.credentials).toBe('include');
  const headers = init.headers as Record<string, string>;
  expect(headers['X-0xNullAI-Usage-Kind']).toBe('agent');
  expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(init.body as string)).toMatchObject({
    model: 'balanced',
    stream: false,
    max_tokens: 2048,
  });
  expect(loadScenes().scenes).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: '生成 1 个角色' }));
  expect(await screen.findByText('已保存到「角色与场景」，仅你可见：')).toBeTruthy();
  const secondKey = (fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>;
  expect(secondKey['Idempotency-Key']).not.toBe(headers['Idempotency-Key']);

  const saved = loadScenes().scenes;
  expect(saved.map((card) => [card.kind, card.name])).toEqual([
    ['scene', '雾港'],
    ['character', '林雾'],
  ]);
  expect(saved.every((card) => !card.id.startsWith('market-'))).toBe(true);
  expect(saved.every((card) => card.derivedFrom?.itemId === 'item-1')).toBe(true);
  expect(saved[1]!.characterCard).toMatchObject({
    creator: '@writer',
    license: '改编自《雾港》，由猫愿模型整理；仅供个人使用',
  });
  expect(loadScenes().selectedId).toBe('');

  fireEvent.click(screen.getByRole('button', { name: '和 林雾 聊天' }));
  expect(onStartChat).toHaveBeenCalledWith(saved[1]);
  expect(onClose).toHaveBeenCalled();
});

it('shows insufficient Credit and saves nothing', async () => {
  fetchMock
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(json(402, { error: 'Credit 不足', credit: { status: 'insufficient' } }));
  render(<ScriptSplitterDialog source={source} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '开始整理' }, { timeout: 2000 }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('Credit 不足，兑换卡密后再试'),
  );
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(loadScenes().scenes).toEqual([]);
});

it('stops on bad JSON for one character, then continues or keeps only finished cards', async () => {
  const second = {
    ...character,
    name: '老周',
    exampleDialogue: '你：在吗？\n老周：在呢，今晚的酒还给你留着一壶。',
  };
  fetchMock
    .mockResolvedValueOnce(catalog())
    .mockResolvedValueOnce(completion(JSON.stringify(outline)))
    .mockResolvedValueOnce(completion(JSON.stringify(character)))
    .mockResolvedValueOnce(completion('{"name": "老周", "description": '));
  render(<ScriptSplitterDialog source={source} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '开始整理' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '老周' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '同时保存场景' }));
  fireEvent.click(screen.getByRole('button', { name: '生成 2 个角色' }));

  expect((await screen.findByRole('alert')).textContent).toContain('JSON');
  expect(loadScenes().scenes).toEqual([]);
  expect(screen.getByRole('button', { name: '只保存已完成的 1 个' })).toBeTruthy();

  // 继续 asks only for the missing character.
  fetchMock.mockResolvedValueOnce(completion(JSON.stringify(second)));
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  expect(await screen.findByText('已保存到「角色与场景」，仅你可见：')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(loadScenes().scenes.map((card) => card.name)).toEqual(['林雾', '老周']);
});

it('requires sign-in and makes no request', () => {
  auth.account = null;
  render(<ScriptSplitterDialog source={source} onClose={vi.fn()} />);
  expect(screen.getByText(/请先登录后使用/)).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});
