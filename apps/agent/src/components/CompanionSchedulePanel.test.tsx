// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionSchedulePanel } from './CompanionSchedulePanel';
const api = vi.hoisted(() => ({
  listCompanionSchedules: vi.fn(),
  saveCompanionSchedule: vi.fn(),
  deleteCompanionSchedule: vi.fn(),
  listCompanionNotifications: vi.fn(),
  readCompanionNotification: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
const item = {
  id: 's',
  version: 1,
  relationshipId: 'r',
  conversationId: 'c',
  kind: 'weekly',
  localTime: '09:00',
  timeZone: 'UTC',
  weekdays: [1],
  quietStart: '22:00',
  quietEnd: '08:00',
  dailyLimit: 1,
  template: '下午一起散步吗？',
  paused: false,
  nextRunAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.listCompanionSchedules.mockResolvedValue({ items: [] });
  api.listCompanionNotifications.mockResolvedValue({ items: [] });
  api.readCompanionNotification.mockResolvedValue({ ok: true });
  api.saveCompanionSchedule.mockResolvedValue({ item });
  api.deleteCompanionSchedule.mockResolvedValue({ ok: true });
});
describe('companion schedule panel', () => {
  it('creates explicit free templates with the selected relationship and conversation', async () => {
    render(<CompanionSchedulePanel accountId="alice" relationshipId="r" conversationId="c" />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText('消息模板').closest('fieldset') as HTMLFieldSetElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('消息模板'), { target: { value: '记得喝水' } });
    fireEvent.submit(screen.getByRole('button', { name: '添加定时消息' }).closest('form')!);
    await waitFor(() =>
      expect(api.saveCompanionSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 0,
          relationshipId: 'r',
          conversationId: 'c',
          template: '记得喝水',
          paused: false,
        }),
      ),
    );
    expect(screen.getByText(/0 Credit/)).toBeTruthy();
  });
  it('requires explicit budget and context consent for actual model generation', async () => {
    api.listCompanionSchedules.mockResolvedValue({
      items: [],
      capability: { enabled: true, credits: 5, priceVersion: 'quote-v1', reason: null },
    });
    render(<CompanionSchedulePanel accountId="alice" relationshipId="r" conversationId="c" />);
    await waitFor(() =>
      expect((screen.getByLabelText('由AI根据近期对话主动聊天') as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByLabelText('由AI根据近期对话主动聊天'));
    fireEvent.click(screen.getByLabelText(/允许将本角色关系资料/));
    fireEvent.change(screen.getByLabelText('消息模板'), {
      target: { value: '温和跟进最近谈到的计划' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '添加定时消息' }).closest('form')!);
    await waitFor(() =>
      expect(api.saveCompanionSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'model',
          acceptedCredits: 5,
          generationPriceVersion: 'quote-v1',
          contextConsent: true,
        }),
      ),
    );
  });
  it('ignores late old-account list results and passes CAS version for pause/delete', async () => {
    let oldResolve!: (value: { items: (typeof item)[] }) => void;
    api.listCompanionSchedules
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResolve = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ ...item, relationshipId: 'r2', conversationId: 'c2' }] });
    const view = render(
      <CompanionSchedulePanel accountId="alice" relationshipId="r" conversationId="c" />,
    );
    view.rerender(
      <CompanionSchedulePanel accountId="bob" relationshipId="r2" conversationId="c2" />,
    );
    await screen.findByText(item.template);
    await act(async () => oldResolve({ items: [{ ...item, template: '旧账号私密内容' }] }));
    expect(screen.queryByText('旧账号私密内容')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    await waitFor(() =>
      expect(api.saveCompanionSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's', version: 1, paused: true, relationshipId: 'r2' }),
      ),
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.deleteCompanionSchedule).toHaveBeenCalledWith('s', 1));
  });
});
