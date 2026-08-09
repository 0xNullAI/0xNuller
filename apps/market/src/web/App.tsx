import { useCallback, useEffect, useState } from 'react';
import type { ItemType, MarketItem } from '../shared/schema';
import { fetchItems, markViewed } from './api';
import { ModuleActions } from '@0xnullai/ui';
import { ItemCard } from './components/ItemCard';
import { ItemDetail } from './components/ItemDetail';
import { UploadDialog } from './components/UploadDialog';

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
  // The theme goes through the shared store. This used to hold an applyTheme that fully
  // duplicated the one in @0xnullai/ui — both implementations wrote data-theme on their
  // own, and once mounted in the unified shell they kept overriding each other.

  function openItem(item: MarketItem) {
    // Optimistically bump the view count to avoid a refetch
    const bumped = { ...item, views: item.views + 1 };
    setActive(bumped);
    void markViewed(item.id);
    setItems((prev) => prev.map((it) => (it.id === item.id ? bumped : it)));
  }

  // The top-level tab plus the scene sub-filter together decide which content type string
  // to fetch.
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
    // mkt-scope must sit on the **outer** element: the whole stylesheet is wrapped in
    // `.mkt-scope { … }`, which compiles into descendant selectors like `.mkt-scope .app`.
    // Put both classes on the same element and the `.app` rule can never match itself —
    // the observed result is a page that no longer caps its width and a filter bar that
    // overflows off screen.
    //
    // The scope itself is required: this stylesheet uses nothing but generic class names
    // (.app / .grid / .btn), and the module layer is ordered after utilities, so without
    // isolation its .grid would win over Tailwind's grid-cols-*.
    <div className="mkt-scope h-full overflow-y-auto">
      <div className="app">
        {/* A single bar: app switcher on the left, categories and search in the middle,
          theme and upload on the right. Before the merge this was a two-row heavy header
          (a brand block plus a separate filter row), very different from Agent's thin bar. */}
        {/* The module name is expressed by the top of the shell sidebar, so it is not
          repeated here; filters are content, not chrome, so they stay put. */}
        <header className="topbar">
          <div className="topbar-filters">
            <div className="seg">
              <button className={tab === 'scene' ? 'active' : ''} onClick={() => setTab('scene')}>
                场景
              </button>
              <button
                className={tab === 'waveform' ? 'active' : ''}
                onClick={() => setTab('waveform')}
              >
                波形
              </button>
            </div>
            {tab === 'scene' && (
              <div className="seg seg-sub">
                <button
                  className={sceneSub === 'scenario' ? 'active' : ''}
                  onClick={() => setSceneSub('scenario')}
                >
                  单人
                </button>
                <button
                  className={sceneSub === 'multi-scene' ? 'active' : ''}
                  onClick={() => setSceneSub('multi-scene')}
                >
                  多人
                </button>
              </div>
            )}
            <input
              className="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称 / 简介 / 标签"
            />
            <select
              className="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as 'new' | 'popular')}
            >
              <option value="new">最新</option>
              <option value="popular">最热</option>
            </select>
          </div>

          {/* Upload is projected into the shell's button slot so it lands on the same line
            as the other modules' buttons. */}
          <ModuleActions>
            <button className="btn primary" onClick={() => setUploading(true)}>
              上传
            </button>
          </ModuleActions>
        </header>

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
          内容由社区上传，请遵守当地法律法规 ·{' '}
          <a href="https://github.com/0xNullAI/0xNuller" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  );
}
