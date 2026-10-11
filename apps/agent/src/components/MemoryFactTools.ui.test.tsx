// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryFactTools } from './MemoryFactTools';

const api = vi.hoisted(() => ({
  listMemoryPeople: vi.fn(),
  listPersonalMemories: vi.fn(),
  saveMemoryPerson: vi.fn(),
  deleteMemoryPerson: vi.fn(),
  linkMemoryPerson: vi.fn(),
  unlinkMemoryPerson: vi.fn(),
  supersedeMemoryFact: vi.fn(),
  correctMemoryFact: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);

const person = {
  id: 'person-1',
  relationshipId: 'relationship-1',
  displayName: '林然',
  aliases: ['小林'],
  version: 2,
  createdAt: 1,
  updatedAt: 2,
};
const oldFact = {
  id: 'old-fact',
  kind: 'note',
  title: '旧住址',
  content: '林然住在旧城',
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  scope: 'relationship',
  relationshipId: 'relationship-1',
  state: 'active',
  effectiveState: 'active',
  personId: null,
};
const newFact = {
  ...oldFact,
  id: 'new-fact',
  title: '新住址',
  content: '林然搬到新城',
  version: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listMemoryPeople.mockResolvedValue({ items: [person], limit: 200 });
  api.listPersonalMemories.mockResolvedValue({ items: [oldFact, newFact], limit: 200 });
});
afterEach(cleanup);

// The tools render flat inside the 高级 section; nothing needs to be unfolded first.
function openEditor() {
  render(<MemoryFactTools relationshipId="relationship-1" />);
  expect(screen.getByRole('region', { name: '高级' })).toBeTruthy();
  expect(document.querySelector('details')).toBeNull();
}

it('only requests people and memories inside the selected relationship and links with server versions', async () => {
  api.linkMemoryPerson.mockResolvedValue({ item: { ...oldFact, version: 4, personId: person.id } });
  openEditor();
  expect(await screen.findByText('林然 · 小林')).toBeTruthy();
  expect(api.listMemoryPeople).toHaveBeenCalledWith('relationship-1');
  expect(api.listPersonalMemories).toHaveBeenCalledWith('relationship-1');

  fireEvent.change(screen.getByLabelText('关联人物 旧住址'), {
    target: { value: person.id },
  });
  await waitFor(() => expect(api.linkMemoryPerson).toHaveBeenCalledWith(person, oldFact));
  expect(await screen.findByText('已关联人物，别名可帮助检索此事实')).toBeTruthy();
});

it('can unlink a person without deleting the confirmed fact', async () => {
  const linked = { ...oldFact, personId: person.id };
  api.listPersonalMemories.mockResolvedValue({ items: [linked], limit: 200 });
  api.unlinkMemoryPerson.mockResolvedValue({ item: { ...linked, personId: null, version: 4 } });
  openEditor();
  const select = (await screen.findByLabelText('关联人物 旧住址')) as HTMLSelectElement;
  expect(select.value).toBe(person.id);
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(api.unlinkMemoryPerson).toHaveBeenCalledWith(linked));
  expect(await screen.findByText('已解除人物关联')).toBeTruthy();
  expect(screen.getByText('旧住址')).toBeTruthy();
});

it('retires the old fact only after a distinct confirmed replacement is selected', async () => {
  const superseded = {
    ...oldFact,
    version: 4,
    supersededById: newFact.id,
    effectiveState: 'superseded',
  };
  api.listPersonalMemories
    .mockResolvedValueOnce({ items: [oldFact, newFact], limit: 200 })
    .mockResolvedValue({ items: [superseded, newFact], limit: 200 });
  api.supersedeMemoryFact.mockResolvedValue({
    item: superseded,
  });
  openEditor();
  await screen.findByText('林然 · 小林');
  const button = screen.getByRole('button', { name: '确认替换旧事实' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('旧事实'), { target: { value: oldFact.id } });
  fireEvent.change(screen.getByLabelText('正确的新事实'), { target: { value: newFact.id } });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(api.supersedeMemoryFact).toHaveBeenCalledWith(oldFact, newFact));
  expect(await screen.findByText('旧事实已退出后续 AI 回答；新事实仍可编辑或删除')).toBeTruthy();
  await waitFor(() => expect(screen.queryAllByRole('option', { name: /旧住址/ })).toHaveLength(0));
});

it('saves a correction and retires the old fact in one request', async () => {
  const corrected = { ...oldFact, id: 'corrected-fact', content: '林然住在新城', version: 1 };
  api.listPersonalMemories
    .mockResolvedValueOnce({ items: [oldFact, newFact], limit: 200 })
    .mockResolvedValue({ items: [corrected, newFact], limit: 200 });
  api.correctMemoryFact.mockResolvedValue({
    item: corrected,
    replacesId: oldFact.id,
  });
  openEditor();
  await screen.findByText('林然 · 小林');
  fireEvent.change(screen.getByLabelText('旧事实'), { target: { value: oldFact.id } });
  expect((screen.getByLabelText('正确内容') as HTMLTextAreaElement).value).toBe(oldFact.content);
  const button = screen.getByRole('button', { name: '确认更正' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('正确内容'), {
    target: { value: '林然住在新城' },
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(api.correctMemoryFact).toHaveBeenCalledWith(oldFact, {
      kind: 'note',
      title: '旧住址',
      content: '林然住在新城',
    }),
  );
  expect(await screen.findByText('旧事实已停用，正确内容已保存')).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryAllByRole('option', { name: /林然住在旧城/ })).toHaveLength(0),
  );
});
