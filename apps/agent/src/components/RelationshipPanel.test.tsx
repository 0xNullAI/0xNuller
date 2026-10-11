// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelationshipPanel } from './RelationshipPanel';

const auth = vi.hoisted(() => ({
  listCharacterRelationships: vi.fn(),
  ensureCharacterRelationship: vi.fn(),
  saveCharacterRelationship: vi.fn(),
  deleteCharacterRelationship: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => auth);
beforeEach(() => {
  vi.resetAllMocks();
  auth.listCharacterRelationships.mockResolvedValue({ items: [] });
  auth.ensureCharacterRelationship.mockRejectedValue(new Error('explicit action required'));
});
afterEach(cleanup);
it('saves private naming with the stable character id and preserves it when the author name changes', async () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <RelationshipPanel characterId="scene" characterName="公开名字" onChange={onChange} />,
  );
  const name = await screen.findByLabelText('给 AI 的名字');
  fireEvent.change(name, { target: { value: '小雨' } });
  fireEvent.change(screen.getByLabelText('AI 怎么称呼你'), { target: { value: '阿明' } });
  auth.saveCharacterRelationship.mockImplementation(async (input) => ({
    item: { ...input, version: 1 },
  }));
  fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        characterId: 'scene',
        aiNickname: '小雨',
        userPreferredName: '阿明',
      }),
    ),
  );
  rerender(
    <RelationshipPanel characterId="scene" characterName="作者新名字" onChange={onChange} />,
  );
  expect((screen.getByLabelText('给 AI 的名字') as HTMLInputElement).value).toBe('小雨');
  expect(auth.listCharacterRelationships).toHaveBeenCalledTimes(1);
});
it('keeps the edited draft after a conflict and offers a server refresh', async () => {
  render(<RelationshipPanel characterId="scene" characterName="角色" />);
  fireEvent.change(await screen.findByLabelText('给 AI 的名字'), { target: { value: '保留草稿' } });
  auth.saveCharacterRelationship.mockRejectedValue(new Error('版本冲突'));
  fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('版本冲突'),
  );
  expect((screen.getByLabelText('给 AI 的名字') as HTMLInputElement).value).toBe('保留草稿');
  const originalId = auth.saveCharacterRelationship.mock.calls[0]![0].id;
  fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
  await waitFor(() => expect(auth.saveCharacterRelationship).toHaveBeenCalledTimes(2));
  expect(auth.saveCharacterRelationship.mock.calls[1]![0].id).toBe(originalId);
});
it('clears the loaded relation when switching characters', async () => {
  auth.listCharacterRelationships.mockResolvedValueOnce({
    items: [{ id: 'r', aiNickname: '旧私名', version: 1 }],
  });
  const { rerender } = render(<RelationshipPanel characterId="old" characterName="旧角色" />);
  await waitFor(() =>
    expect((screen.getByLabelText('给 AI 的名字') as HTMLInputElement).value).toBe('旧私名'),
  );
  rerender(<RelationshipPanel characterId="new" characterName="新角色" />);
  await waitFor(() =>
    expect((screen.getByLabelText('给 AI 的名字') as HTMLInputElement).value).toBe(''),
  );
});
it('uses the automatically materialized private identity for later naming edits', async () => {
  auth.ensureCharacterRelationship.mockResolvedValue({
    item: {
      id: 'private-r',
      characterId: 'market-card-1',
      aiNickname: '',
      userPreferredName: '',
      relationshipType: '',
      notes: '',
      version: 1,
    },
  });
  render(<RelationshipPanel characterId="market-card-1" characterName="公开名字" />);
  await waitFor(() =>
    expect(auth.ensureCharacterRelationship).toHaveBeenCalledWith('market-card-1'),
  );
  fireEvent.change(await screen.findByLabelText('给 AI 的名字'), { target: { value: '专属名字' } });
  auth.saveCharacterRelationship.mockResolvedValue({
    item: { id: 'private-r', version: 2, aiNickname: '专属名字' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
  await waitFor(() =>
    expect(auth.saveCharacterRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'private-r', version: 1, aiNickname: '专属名字' }),
    ),
  );
});
