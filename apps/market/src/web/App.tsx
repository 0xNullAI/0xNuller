import { AppSwitcher } from '@0xnullai/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ItemType, MarketItem } from '../shared/schema';
import { fetchItems, markViewed } from './api';
import { applyTheme, getStoredMode, setMode, subscribeSystem, type ThemeMode } from './theme';
import { ItemCard } from './components/ItemCard';
import { ItemDetail } from './components/ItemDetail';
import { UploadDialog } from './components/UploadDialog';

const THEME_LABEL: Record<ThemeMode, string> = { auto: '🌗 跟随系统', light: '☀️ 浅色', dark: '🌙 深色' };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { auto: 'light', light: 'dark', dark: 'auto' };

type TopTab = 'scene' | 'waveform';
type SceneSub = 'scenario' | 'multi-scene';

export function App(): JSX.Element {
  const [tab, setTab] = useState<TopTab>('scene');
  const [sceneSub, setSceneSub] = useState<SceneSub>('scenario');
  const [sort, setSort] = useState<'new' | 'popular'>('new');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<MarketItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredMode());

  // auto 模式下跟随系统配色变化。
  useEffect(() => subscribeSystem(themeMode, () => applyTheme(themeMode)), [themeMode]);

  function cycleTheme() {
    const next = THEME_NEXT[themeMode];
    setThemeMode(next);
    setMode(next);
  }

  function openItem(item: MarketItem) {
    // 乐观自增浏览量，避免重新拉取
    const bumped = { ...item, views: item.views + 1 };
    setActive(bumped);
    void markViewed(item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? bumped : it)));
  }

  // 由顶层标签 + 场景子筛选共同决定要拉取的内容类型字符串。
  const activeType: ItemType = tab === 'waveform' ? 'waveform' : sceneSub;

  const load = useCallback(() => {
    setLoading(true);
    fetchItems({ type: activeType, sort, q: q.trim() || undefined, limit: 50 })
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [activeType, sort, q]);

  useEffect(() => {
    const id = window.setTimeout(load, q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [load, q]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <AppSwitcher current="market" label="DG-Market" />
            <small>波形与场景社区 · 配合 DG-Agent 使用</small>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={cycleTheme} title="切换主题">
            {THEME_LABEL[themeMode]}
          </button>
          <button className="btn primary" onClick={() => setUploading(true)}>
            上传
          </button>
        </div>
      </header>

      <nav className="controls">
        <div className="tab-group">
          <div className="seg">
            <button className={tab === 'scene' ? 'active' : ''} onClick={() => setTab('scene')}>
              场景
            </button>
            <button className={tab === 'waveform' ? 'active' : ''} onClick={() => setTab('waveform')}>
              波形
            </button>
          </div>
          {tab === 'scene' && (
            <div className="seg seg-sub">
              <button className={sceneSub === 'scenario' ? 'active' : ''} onClick={() => setSceneSub('scenario')}>
                单人
              </button>
              <button className={sceneSub === 'multi-scene' ? 'active' : ''} onClick={() => setSceneSub('multi-scene')}>
                多人
              </button>
            </div>
          )}
        </div>
        <input
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名称 / 简介 / 标签"
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'popular')}>
          <option value="new">最新</option>
          <option value="popular">最热</option>
        </select>
      </nav>

      <main className="grid">
        {loading ? (
          <p className="empty">加载中…</p>
        ) : items.length === 0 ? (
          <p className="empty">还没有内容，来上传第一个吧！</p>
        ) : (
          items.map((item) => <ItemCard key={item.id} item={item} onOpen={openItem} />)
        )}
      </main>

      {active && (
        <ItemDetail
          item={active}
          onClose={() => setActive(null)}
          onUpdated={(updated) => {
            setActive(updated);
            setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
          }}
        />
      )}
      {uploading && (
        <UploadDialog
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            load();
          }}
          onChanged={load}
        />
      )}

      <footer className="foot">
        DG-Market · 内容由社区上传，请遵守当地法律法规 ·{' '}
        <a href="https://github.com/0xNullAI/DG-Agent" target="_blank" rel="noreferrer">
          DG-Agent
        </a>
      </footer>
    </div>
  );
}
