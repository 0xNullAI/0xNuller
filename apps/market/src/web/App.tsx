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
  // 主题走共享 store。这里原本有一份与 @0xnullai/ui 完全重复的 applyTheme——
  // 两份实现各自往 data-theme 写，挂进统一外壳后互相顶掉。

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
    // mkt-scope 必须在**外层**：样式表整份包在 `.mkt-scope { … }` 里，编译出来是
    // `.mkt-scope .app` 这样的后代选择器。把两个类放在同一个元素上，`.app` 那条规则
    // 就永远匹配不到自己——实测表现是整页不再限宽、筛选栏溢出到屏幕外。
    //
    // 加作用域本身是必需的：这份样式用的全是通用类名（.app / .grid / .btn），而
    // module 层排在 utilities 之后，不隔离的话它的 .grid 会压过 Tailwind 的 grid-cols-*。
    <div className="mkt-scope h-full overflow-y-auto">
      <div className="app">
        {/* 单条横栏：左侧应用切换器，中间分类与搜索，右侧主题与上传。
          合并前这里是「品牌块 + 独立筛选行」两行重头部，与 Agent 的细横栏差别很大。 */}
        {/* 模块名由外壳侧边栏顶部表达，这里不再重复；筛选是内容不是 chrome，留在原地。 */}
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

          {/* 上传投到外壳的按钮插槽，和别的模块的按钮落在同一条线上。 */}
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
          Market · 内容由社区上传，请遵守当地法律法规 ·{' '}
          <a href="https://github.com/0xNullAI/DG-Agent" target="_blank" rel="noreferrer">
            Agent
          </a>
        </footer>
      </div>
    </div>
  );
}
