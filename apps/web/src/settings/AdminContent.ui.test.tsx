// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminContent } from './AdminContent';

const api = vi.hoisted(() => ({
  getAdminStats: vi.fn(),
  getAdminReports: vi.fn(),
  resolveAdminReport: vi.fn(),
  grantCreditGift: vi.fn(),
  lookupAdminCreditTarget: vi.fn(),
  listAdminCreditRedPackets: vi.fn(),
  approveAdminCreditRedPacket: vi.fn(),
  rejectAdminCreditRedPacket: vi.fn(),
  getAdminLedgerSummary: vi.fn(),
  listAdminLedger: vi.fn(),
  mintRedeemCodes: vi.fn(),
  listRedeemBatches: vi.fn(),
  listRedeemBatchCodes: vi.fn(),
  listRedemptions: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => api);
vi.mock('./BillingReconciliationPanel', () => ({
  BillingReconciliationPanel: () => <div>对账面板</div>,
}));
vi.mock('./RuntimeHealthPanel', () => ({ RuntimeHealthPanel: () => <div>运行状况面板</div> }));
const market = vi.hoisted(() => ({
  fetchAdminItems: vi.fn(),
  setItemHidden: vi.fn(),
  deleteItem: vi.fn(),
}));
vi.mock('../../../market/src/web/api', () => market);

// 2026-10-13 12:00 China time.
const NOW = Date.UTC(2026, 9, 13, 4);
const TODAY_START = Date.UTC(2026, 9, 12, 16);
const DAY = 86_400_000;

const summary = {
  from: TODAY_START - 6 * DAY,
  to: TODAY_START + DAY,
  days: [
    {
      date: '2026-10-13',
      groups: { redeem: { entries: 1, credits: 1000 }, usage: { entries: 3, credits: -120 } },
    },
    { date: '2026-10-12', groups: { gift: { entries: 1, credits: 500 } } },
  ],
  totals: {
    redeem: { entries: 1, credits: 1000 },
    purchase: { entries: 1, credits: 5000 },
    usage: { entries: 3, credits: -120 },
    gift: { entries: 1, credits: 500 },
  },
};

const entry = (id: number, username: string, amountCredits: number, group = 'usage') => ({
  id,
  username,
  group,
  kind: group,
  amountCredits,
  referenceId: `ref-${id}`,
  detail: null,
  createdAt: NOW - id * 1000,
});

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  vi.resetAllMocks();
  market.fetchAdminItems.mockResolvedValue({ items: [], nextOffset: null });
  api.getAdminStats.mockResolvedValue({
    generatedAt: NOW,
    users: 10,
    verifiedUsers: 8,
    activeSessions: 3,
    registrationAttempts24h: 1,
    creditUsedToday: 120,
    creditPurchasedToday: 0,
    openReports: 2,
  });
  api.getAdminReports.mockResolvedValue([]);
  api.listAdminCreditRedPackets.mockResolvedValue({
    items: [{ id: 'p1', status: 'pending', username: 'bob', code: 'X', createdAt: NOW }],
  });
  api.getAdminLedgerSummary.mockResolvedValue(summary);
  api.listAdminLedger.mockResolvedValue({
    entries: [entry(1, 'alice', -20), entry(2, 'bob', 1000, 'redeem')],
    nextCursor: 2,
  });
  api.listRedeemBatches.mockResolvedValue({
    batches: [
      {
        id: 'batch-1',
        amountCny: 35,
        amountCredits: 5000,
        count: 2,
        redeemed: 1,
        note: '渠道A',
        operator: 'root',
        createdAt: NOW,
      },
    ],
    nextCursor: null,
  });
  api.listRedeemBatchCodes.mockResolvedValue({
    codes: [
      { id: 'c1', tail: 'AB12', redeemedBy: 'carol', redeemedAt: NOW },
      { id: 'c2', tail: 'CD34', redeemedBy: null, redeemedAt: null },
    ],
  });
  api.listRedemptions.mockResolvedValue({
    redemptions: [
      {
        id: 'c1',
        tail: 'AB12',
        amountCny: 35,
        amountCredits: 5000,
        note: '渠道A',
        redeemedBy: 'carol',
        redeemedAt: NOW,
      },
    ],
    nextCursor: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('admin page', () => {
  it('switches sub-tabs, remembers the choice and has no manual top-up', async () => {
    const { unmount } = render(<AdminContent />);
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true');
    openTab('对账审核');
    expect(screen.getByText('对账面板')).toBeTruthy();
    openTab('内容与运行');
    expect(screen.getByText('运行状况面板')).toBeTruthy();
    expect(screen.queryByText('对账面板')).toBeNull();
    openTab('赠送');
    expect(screen.getByRole('region', { name: '赠送 Credit' })).toBeTruthy();
    expect(screen.queryByText('人工充值')).toBeNull();
    expect(screen.queryByLabelText('外部流水号')).toBeNull();
    unmount();
    render(<AdminContent />);
    expect(screen.getByRole('tab', { name: '赠送' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows today and 7-day headline totals and pending counts on the overview', async () => {
    render(<AdminContent />);
    const today = await screen.findByRole('group', { name: '今天' });
    expect(within(today).getByText('+1,000')).toBeTruthy();
    expect(within(today).getByText('-120')).toBeTruthy();
    const week = screen.getByRole('group', { name: '近 7 天' });
    expect(within(week).getByText('+6,000')).toBeTruthy();
    expect(within(week).getByText('+500')).toBeTruthy();
    expect(api.getAdminLedgerSummary).toHaveBeenCalledWith({
      from: TODAY_START - 6 * DAY,
      to: TODAY_START + DAY,
    });
    const pending = screen.getByRole('region', { name: '待处理' });
    await waitFor(() => expect(within(pending).getByText('1')).toBeTruthy());
    expect(within(pending).getByText('2')).toBeTruthy();
  });

  it('filters the ledger, shows the daily strip and pages with the same filter', async () => {
    render(<AdminContent />);
    openTab('账单');
    await screen.findByText('@alice');
    expect(api.listAdminLedger).toHaveBeenLastCalledWith({
      from: TODAY_START - 6 * DAY,
      to: TODAY_START + DAY,
    });

    const days = screen.getAllByTestId('ledger-day');
    expect(days).toHaveLength(2);
    expect(within(days[0]!).getByText('2026-10-13')).toBeTruthy();
    expect(within(days[0]!).getByText('卡密兑换')).toBeTruthy();
    expect(within(days[0]!).getByText('-120')).toBeTruthy();
    expect(within(days[1]!).getByText('+500')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    await waitFor(() =>
      expect(api.listAdminLedger).toHaveBeenLastCalledWith({
        from: TODAY_START,
        to: TODAY_START + DAY,
      }),
    );

    fireEvent.change(screen.getByLabelText('类别'), { target: { value: 'usage' } });
    await waitFor(() =>
      expect(api.listAdminLedger).toHaveBeenLastCalledWith({
        group: 'usage',
        from: TODAY_START,
        to: TODAY_START + DAY,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: '只看 @alice' }));
    const userFilter = {
      username: 'alice',
      group: 'usage',
      from: TODAY_START,
      to: TODAY_START + DAY,
    };
    await waitFor(() => expect(api.listAdminLedger).toHaveBeenLastCalledWith(userFilter));
    expect(api.getAdminLedgerSummary).toHaveBeenLastCalledWith(userFilter);
    expect((screen.getByLabelText('按用户名筛选') as HTMLInputElement).value).toBe('alice');

    fireEvent.click(screen.getByRole('button', { name: '自定义' }));
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-02' } });
    const customFilter = {
      username: 'alice',
      group: 'usage',
      from: Date.UTC(2026, 8, 30, 16),
      to: Date.UTC(2026, 9, 2, 16),
    };
    await waitFor(() => expect(api.listAdminLedger).toHaveBeenLastCalledWith(customFilter));

    api.listAdminLedger.mockResolvedValueOnce({
      entries: [entry(3, 'alice', -5)],
      nextCursor: null,
    });
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(api.listAdminLedger).toHaveBeenLastCalledWith(customFilter, 2));
    expect(await screen.findByText('-5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  });

  it('mints keys, shows them once with copy and CSV download', async () => {
    const codes = ['A'.repeat(64), 'B'.repeat(64)];
    api.mintRedeemCodes.mockResolvedValue({
      batch: {
        id: 'batch-2',
        amountCny: 68,
        amountCredits: 12000,
        count: 2,
        note: '活动',
        createdAt: NOW,
      },
      codes,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:codes';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    render(<AdminContent />);
    openTab('卡密');
    fireEvent.click(screen.getByRole('radio', { name: /¥68/ }));
    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: ' 活动 ' } });
    fireEvent.click(screen.getByRole('button', { name: '生成卡密' }));

    const list = await screen.findByRole('list', { name: '卡密列表' });
    expect(api.mintRedeemCodes).toHaveBeenCalledWith({ amountCny: 68, count: 2, note: '活动' });
    expect(within(list).getByText(codes[0]!)).toBeTruthy();
    expect(screen.getByText(/只显示这一次/)).toBeTruthy();
    // The batch list refreshes to include the new batch.
    await waitFor(() => expect(api.listRedeemBatches).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: '复制全部' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(codes.join('\n')));

    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }));
    expect(downloads).toEqual(['redeem-codes-batch-2.csv']);
    const csv = await blobs[0]!.text();
    expect(csv.replace(/^\uFEFF/, '').split('\r\n')).toEqual([
      'key,amount_cny,credits,batch_id,note',
      `${codes[0]},68,12000,batch-2,活动`,
      `${codes[1]},68,12000,batch-2,活动`,
      '',
    ]);

    // Keys survive a sub-tab switch but are gone once dismissed.
    openTab('账单');
    openTab('卡密');
    expect(screen.getByText(codes[1]!)).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByText(codes[0]!)).toBeNull();
    expect(screen.getByRole('button', { name: '生成卡密' })).toBeTruthy();
    click.mockRestore();
  });

  it('expands a batch to masked tails and links a redeemer to the ledger', async () => {
    render(<AdminContent />);
    openTab('卡密');
    const batch = await screen.findByRole('button', { name: '批次 batch-1' });
    expect(batch.textContent).toContain('已兑换 1/2');
    expect(batch.textContent).toContain('渠道A');
    expect(batch.textContent).toContain('@root');
    fireEvent.click(batch);
    const codes = await screen.findByRole('list', { name: '批次卡密' });
    expect(api.listRedeemBatchCodes).toHaveBeenCalledWith('batch-1');
    expect(within(codes).getByText('••••AB12')).toBeTruthy();
    expect(within(codes).getByText('已兑换 · @carol')).toBeTruthy();
    expect(within(codes).getByText('未使用')).toBeTruthy();
    expect(batch.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(await screen.findByRole('button', { name: '查看 @carol 的账单' }));
    await waitFor(() =>
      expect(api.listAdminLedger).toHaveBeenLastCalledWith({
        username: 'carol',
        from: TODAY_START - 6 * DAY,
        to: TODAY_START + DAY,
      }),
    );
    expect(screen.getByRole('tab', { name: '账单' }).getAttribute('aria-selected')).toBe('true');
  });
});
