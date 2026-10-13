import { useState, type KeyboardEvent } from 'react';
import { readPreference, writePreference } from '@0xnullai/settings';
import { AdminGiftPanel } from './AdminGiftPanel';
import { AdminLedgerPanel } from './AdminLedgerPanel';
import { AdminOperationsPanel } from './AdminOperationsPanel';
import { AdminOverview } from './AdminOverview';
import { AdminRedeemCodesPanel, type MintedCodes } from './AdminRedeemCodesPanel';
import { BillingReconciliationPanel } from './BillingReconciliationPanel';

const ADMIN_TABS = [
  ['overview', '概览'],
  ['ledger', '账单'],
  ['codes', '卡密'],
  ['reconcile', '对账审核'],
  ['gift', '赠送'],
  ['ops', '内容与运行'],
] as const;

type AdminTab = (typeof ADMIN_TABS)[number][0];

const TAB_PREFERENCE = 'dg-admin-tab';

function initialTab(): AdminTab {
  const saved = readPreference(TAB_PREFERENCE);
  return ADMIN_TABS.some(([id]) => id === saved) ? (saved as AdminTab) : 'overview';
}

export function AdminContent() {
  const [tab, setTab] = useState<AdminTab>(initialTab);
  // Shared so a username clicked elsewhere (redemptions) opens 账单 already filtered.
  const [ledgerUser, setLedgerUser] = useState('');
  // Held here so freshly minted keys survive switching sub-tabs; they are never stored.
  const [minted, setMinted] = useState<MintedCodes | null>(null);

  function select(next: AdminTab) {
    setTab(next);
    writePreference(TAB_PREFERENCE, next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = ADMIN_TABS.findIndex(([id]) => id === tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = ADMIN_TABS[(index + step + ADMIN_TABS.length) % ADMIN_TABS.length]![0];
    select(next);
    document.getElementById(`admin-tab-${next}`)?.focus();
  }

  return (
    <section aria-labelledby="admin-content-title" className="flex min-w-0 flex-col gap-4">
      <h2 id="admin-content-title" className="sr-only">
        管理
      </h2>
      <div
        role="tablist"
        aria-label="管理分区"
        onKeyDown={onKeyDown}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
      >
        {ADMIN_TABS.map(([id, label]) => (
          <button
            key={id}
            id={`admin-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls="admin-tab-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => select(id)}
            className={`min-h-[36px] shrink-0 whitespace-nowrap rounded-[var(--radius-ctl)] px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              tab === id
                ? 'bg-[var(--accent-soft)] text-[var(--text)]'
                : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="admin-tab-panel"
        role="tabpanel"
        aria-labelledby={`admin-tab-${tab}`}
        className="flex min-w-0 flex-col gap-4"
      >
        {tab === 'overview' ? <AdminOverview /> : null}
        {tab === 'ledger' ? (
          <AdminLedgerPanel username={ledgerUser} onUsernameChange={setLedgerUser} />
        ) : null}
        {tab === 'codes' ? (
          <AdminRedeemCodesPanel
            minted={minted}
            onMinted={setMinted}
            onShowUser={(username) => {
              setLedgerUser(username);
              select('ledger');
            }}
          />
        ) : null}
        {tab === 'reconcile' ? <BillingReconciliationPanel /> : null}
        {tab === 'gift' ? <AdminGiftPanel /> : null}
        {tab === 'ops' ? <AdminOperationsPanel /> : null}
      </div>
    </section>
  );
}
