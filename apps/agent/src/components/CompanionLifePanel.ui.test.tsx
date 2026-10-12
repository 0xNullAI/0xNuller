// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionLifePanel } from './CompanionLifePanel';
const api = vi.hoisted(() => ({
  listCompanionLife: vi.fn(),
  saveCompanionLife: vi.fn(),
  deleteCompanionLife: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.listCompanionLife.mockResolvedValue({ items: [] });
  api.saveCompanionLife.mockRejectedValue(new Error('版本冲突'));
});
it('retains failed record drafts and clears private drafts when switching accounts', async () => {
  const { rerender } = render(<CompanionLifePanel accountId="alice" relationshipId="r" />);
  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  fireEvent.change(screen.getByLabelText('记录名称'), { target: { value: '我的朋友' } });
  fireEvent.change(screen.getByLabelText('记录内容'), { target: { value: '私人备注' } });
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('私人备注');
  expect(api.saveCompanionLife).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ title: '我的朋友', kind: 'person', version: 0 }),
  );
  await act(async () => rerender(<CompanionLifePanel accountId="bob" relationshipId="r" />));
  expect((screen.getByLabelText('记录内容') as HTMLTextAreaElement).value).toBe('');
});
it('edits the existing lifecycle identity instead of creating a second stage', async () => {
  api.listCompanionLife.mockResolvedValue({
    items: [
      {
        id: 'stage',
        relationshipId: 'r',
        kind: 'lifecycle',
        title: '我们的关系',
        label: 'established',
        content: '',
        occurredOn: null,
        personIds: [],
        version: 4,
      },
    ],
  });
  render(<CompanionLifePanel accountId="alice" relationshipId="r" />);
  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '设置阶段' }));
  fireEvent.change(screen.getByLabelText('关系阶段'), { target: { value: 'paused' } });
  fireEvent.click(screen.getByRole('button', { name: '保存记录' }));
  await waitFor(() =>
    expect(api.saveCompanionLife).toHaveBeenCalledWith(
      'r',
      expect.objectContaining({ id: 'stage', version: 4, label: 'paused', kind: 'lifecycle' }),
    ),
  );
});
