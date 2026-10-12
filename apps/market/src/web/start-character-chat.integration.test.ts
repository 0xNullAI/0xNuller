import { beforeEach, expect, it, vi } from 'vitest';
import { startCharacterChat } from './start-character-chat';

const state = vi.hoisted(() => ({
  account: 'alice',
  item: {
    id: 'card-1',
    type: 'scenario',
    name: '小岚',
    content: {
      prompt: '你是小岚',
      characterCard: {
        schemaVersion: 1,
        description: '',
        personality: '',
        greeting: '',
        exampleDialogue: '',
        tags: [],
        creator: '',
        license: '',
      },
    },
  },
  fetch: vi.fn(),
  ensure: vi.fn(),
  import: vi.fn(),
  newChat: vi.fn(),
  select: vi.fn(),
  list: vi.fn(),
  downloaded: vi.fn(),
  recorded: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => state.account,
  ensureCharacterRelationship: state.ensure,
  requestNewAgentInboxConversation: state.newChat,
  selectAgentInboxConversation: state.select,
  listPrivateConversationSummaries: state.list,
}));
vi.mock('@0xnullai/scenes', () => ({
  importMarketSceneOnline: state.import,
}));
vi.mock('./api', () => ({
  fetchItem: state.fetch,
  markDownloaded: state.downloaded,
  recordCharacterStart: state.recorded,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.account = 'alice';
  state.fetch.mockResolvedValue(state.item);
  state.ensure.mockResolvedValue({ item: { id: 'private-1' } });
  state.import.mockResolvedValue({ selectedId: 'market-card-1' });
  state.downloaded.mockResolvedValue(undefined);
  state.recorded.mockResolvedValue({ recorded: true });
  state.list.mockResolvedValue({ items: [] });
});

it('reopens the latest conversation with the same character instead of creating another', async () => {
  state.list.mockResolvedValue({
    items: [
      { id: 'other', metadata: { promptPresetId: 'market-other' } },
      { id: 'mine', metadata: { promptPresetId: 'market-card-1' } },
    ],
  });
  await startCharacterChat('card-1');
  expect(state.select).toHaveBeenCalledWith('mine');
  expect(state.newChat).not.toHaveBeenCalled();
});

it('starts a new conversation when looking up existing ones fails', async () => {
  state.list.mockRejectedValue(new Error('offline'));
  await startCharacterChat('card-1');
  expect(state.newChat).toHaveBeenCalledOnce();
  expect(state.select).not.toHaveBeenCalled();
});

it('creates the current account relationship and selects the public-card snapshot before opening chat', async () => {
  await startCharacterChat('card-1');
  expect(state.fetch).toHaveBeenCalledWith('card-1');
  expect(state.ensure).toHaveBeenCalledWith('market-card-1');
  expect(state.import).toHaveBeenCalledWith(state.item, { restoreDeleted: true });
  expect(state.newChat).toHaveBeenCalledOnce();
  expect(state.downloaded).toHaveBeenCalledWith('card-1');
  expect(state.recorded).toHaveBeenCalledWith('card-1');
  expect(state.ensure.mock.invocationCallOrder[0]).toBeLessThan(
    state.import.mock.invocationCallOrder[0]!,
  );
});

it('never imports or starts a chat after account switch or failed relationship creation', async () => {
  state.fetch.mockImplementation(async () => {
    state.account = 'bob';
    return state.item;
  });
  await expect(startCharacterChat('card-1')).rejects.toThrow('账号已切换');
  expect(state.ensure).not.toHaveBeenCalled();
  state.account = 'alice';
  state.fetch.mockResolvedValue(state.item);
  state.ensure.mockRejectedValue(new Error('关系已删除'));
  await expect(startCharacterChat('card-1')).rejects.toThrow('关系已删除');
  expect(state.import).not.toHaveBeenCalled();
  expect(state.newChat).not.toHaveBeenCalled();
  expect(state.recorded).not.toHaveBeenCalled();
});

it('does not create a conversation when the account changes during relationship creation', async () => {
  state.ensure.mockImplementation(async () => {
    state.account = 'bob';
    return { item: { id: 'private-1' } };
  });
  await expect(startCharacterChat('card-1')).rejects.toThrow('账号已切换');
  expect(state.import).not.toHaveBeenCalled();
  expect(state.newChat).not.toHaveBeenCalled();
});

it('does not open chat or report a start until the account-owned snapshot is confirmed online', async () => {
  state.import.mockRejectedValueOnce(new Error('角色尚未保存到云端'));
  await expect(startCharacterChat('card-1')).rejects.toThrow('角色尚未保存到云端');
  expect(state.newChat).not.toHaveBeenCalled();
  expect(state.recorded).not.toHaveBeenCalled();
  await expect(startCharacterChat('card-1')).resolves.toBeUndefined();
  expect(state.ensure).toHaveBeenCalledTimes(2);
  expect(state.newChat).toHaveBeenCalledOnce();
});

it('ignores a completed online import after an account switch', async () => {
  state.import.mockImplementationOnce(async () => {
    state.account = 'bob';
    return { selectedId: 'market-card-1' };
  });
  await expect(startCharacterChat('card-1')).rejects.toThrow('账号已切换');
  expect(state.newChat).not.toHaveBeenCalled();
});

it('does not create a relationship or conversation for a public scene', async () => {
  for (const content of [{ prompt: '普通场景' }, { kind: 'scene', prompt: '普通场景' }]) {
    state.fetch.mockResolvedValue({ ...state.item, content });
    await expect(startCharacterChat('card-1')).rejects.toThrow('场景只提供环境设定');
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.import).not.toHaveBeenCalled();
    expect(state.newChat).not.toHaveBeenCalled();
  }
});

it('keeps the private chat path usable when optional Market metrics are unavailable', async () => {
  state.recorded.mockRejectedValue(new Error('Market unavailable'));
  state.downloaded.mockRejectedValue(new Error('Market unavailable'));
  await expect(startCharacterChat('card-1')).resolves.toBeUndefined();
  expect(state.newChat).toHaveBeenCalledOnce();
});
