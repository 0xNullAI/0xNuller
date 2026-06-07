import { useCallback, useEffect, useState } from 'react';
import type { ItemType, MarketItem } from '../shared/schema';
import { fetchConfig, fetchItems } from './api';
import { ItemCard } from './components/ItemCard';
import { ItemDetail } from './components/ItemDetail';
import { UploadDialog } from './components/UploadDialog';

export function App(): JSX.Element {
  const [tab, setTab] = useState<ItemType>('waveform');
  const [sort, setSort] = useState<'new' | 'popular'>('new');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<MarketItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const [siteKey, setSiteKey] = useState('');

  useEffect(() => {
    fetchConfig()
      .then((c) => setSiteKey(c.turnstileSiteKey))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetchItems({ type: tab, sort, q: q.trim() || undefined, limit: 50 })
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [tab, sort, q]);

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
            <h1>DG-Market</h1>
            <small>波形与场景社区 · 配合 DG-Agent 使用</small>
          </div>
        </div>
        <button className="btn primary" onClick={() => setUploading(true)}>
          上传
        </button>
      </header>

      <nav className="controls">
        <div className="seg">
          <button className={tab === 'waveform' ? 'active' : ''} onClick={() => setTab('waveform')}>
            波形
          </button>
          <button className={tab === 'scenario' ? 'active' : ''} onClick={() => setTab('scenario')}>
            场景
          </button>
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
          items.map((item) => <ItemCard key={item.id} item={item} onOpen={setActive} />)
        )}
      </main>

      {active && <ItemDetail item={active} onClose={() => setActive(null)} />}
      {uploading && (
        <UploadDialog
          siteKey={siteKey}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            load();
          }}
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
