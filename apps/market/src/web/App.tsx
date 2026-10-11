import { CharacterModeration } from './components/CharacterReports';
import { FollowedCreators } from './components/FollowedCreators';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gamepad2, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  promptKind,
  type ItemType,
  type MarketItem,
  type PromptKind,
  type ScenarioContent,
} from '../shared/schema';
import {
  fetchBrowsePage,
  fetchItem,
  fetchItemAccess,
  fetchDiscovery,
  markViewed,
  recordCharacterDetailOpen,
} from './api';
import {
  Button,
  useInShell,
  useOpenShellSettings,
  useShellNav,
  useShellSignedIn,
} from '@0xnullai/ui';
import { ItemCard } from './components/ItemCard';
import { ItemDetail } from './components/ItemDetail';
import { UploadDialog } from './components/UploadDialog';
import { CharacterStudio } from './components/CharacterStudio';
import { marketEditorHref, marketEditorRoute } from './market-editor-route';
import { startCharacterChat } from './start-character-chat';
import { importSceneCard } from './import-scene-card';
import { appendBrowsePage, MARKET_PAGE_SIZE } from './browse-pages';
import { filterPlacement } from './filter-placement';

type WaveformModality = 'electrostimulation' | 'vibration';
type Category = PromptKind | 'waveform';
type Studio = { kind: 'new'; cardKind: PromptKind } | { kind: 'edit'; item: MarketItem };
const sortOptions = [
  { value: 'new', label: '最新发布' },
  { value: 'hot', label: '热门内容' },
  { value: 'views', label: '浏览最多' },
  { value: 'downloads', label: '下载最多' },
] as const;
type Sort = (typeof sortOptions)[number]['value'];

export function App(): JSX.Element {
  const shellNav = useShellNav();
  const [cardKind, setCardKind] = useState<PromptKind>('character');
  const [category, setCategory] = useState<Category>('character');
  const [waveformModality, setWaveformModality] = useState<WaveformModality>('electrostimulation');
  const [discovery, setDiscovery] = useState<'all' | 'favorites' | 'following'>('all');
  const [sort, setSort] = useState<Sort>('new');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<MarketItem | null>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [uploading, setUploading] = useState(false);
  const [openMenu, setOpenMenu] = useState<'create' | 'filters' | null>(null);
  const [filterPosition, setFilterPosition] = useState<{
    side: 'top' | 'bottom';
    maxHeight: number;
  } | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const routeRequestId = useRef(0);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const menu = openMenu === 'create' ? createMenuRef.current : filterMenuRef.current;
      if (menu && !menu.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
        if (openMenu === 'filters') filterTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (openMenu !== 'filters') return;
    const updatePosition = () => {
      const trigger = filterTriggerRef.current;
      if (trigger) {
        const pane = trigger.closest('.mkt-scope')?.getBoundingClientRect();
        setFilterPosition(
          filterPlacement(trigger.getBoundingClientRect(), window.innerHeight, 320, pane),
        );
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    // Market scrolls inside its own pane, not the browser window.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [openMenu]);

  const syncRoute = useCallback(() => {
    const request = ++routeRequestId.current;
    detailRequestId.current += 1;
    const editor = marketEditorRoute(window.location.search);
    setRouteError(null);
    setLinkError(null);
    setRouteBusy(false);
    if (editor) {
      setActive(null);
      if (editor.kind === 'invalid') {
        setStudio(null);
        setRouteError('公开内容编辑链接无效');
      } else if (editor.kind === 'new') {
        setStudio({ kind: 'new', cardKind: editor.cardKind ?? 'character' });
      } else {
        const account = currentAuthUserId();
        setStudio(null);
        if (!account) {
          setRouteError('请先登录后编辑公开内容');
          return;
        }
        setRouteBusy(true);
        void Promise.all([fetchItem(editor.itemId), fetchItemAccess(editor.itemId)])
          .then(([item, access]) => {
            if (routeRequestId.current !== request || currentAuthUserId() !== account) return;
            if (!access.canEdit || item.type !== 'scenario') {
              setRouteError('无权编辑此内容');
              return;
            }
            setStudio({ kind: 'edit', item });
          })
          .catch((reason: unknown) => {
            if (routeRequestId.current === request)
              setRouteError(reason instanceof Error ? reason.message : '内容读取失败');
          })
          .finally(() => {
            if (routeRequestId.current === request) setRouteBusy(false);
          });
      }
      return;
    }
    setStudio(null);
    const params = new URLSearchParams(window.location.search);
    const id = params.get('item');
    if (!id) {
      setActive(null);
      return;
    }
    if (params.getAll('item').length !== 1 || !/^[\w-]{1,128}$/.test(id)) {
      setActive(null);
      setLinkError('公开内容链接无效');
      return;
    }
    void fetchItem(id)
      .then((item) => {
        if (routeRequestId.current === request) {
          setActive(item);
          if (
            currentAuthUserId() &&
            item.type === 'scenario' &&
            promptKind(item.content as ScenarioContent) === 'character'
          )
            void recordCharacterDetailOpen(item.id).catch(() => undefined);
        }
      })
      .catch(() => {
        if (routeRequestId.current === request) setLinkError('公开内容已下架或暂时无法读取');
      });
  }, []);

  useEffect(() => {
    let live = true;
    const onHistory = () => syncRoute();
    window.addEventListener('popstate', onHistory);
    queueMicrotask(() => {
      if (live) syncRoute();
    });
    const unsubscribe = subscribeAuthChanges(() => {
      requestId.current += 1;
      detailRequestId.current += 1;
      setItems([]);
      setActive(null);
      setStudio(null);
      setDiscovery('all');
      setAuthRevision((revision) => revision + 1);
      syncRoute();
    });
    return () => {
      live = false;
      routeRequestId.current += 1;
      window.removeEventListener('popstate', onHistory);
      unsubscribe();
    };
  }, [syncRoute]);

  const inShell = useInShell();
  const signedIn = useShellSignedIn();
  const openShellSettings = useOpenShellSettings();
  const requiresAccount = inShell && !signedIn && discovery !== 'all';
  function openItem(item: MarketItem) {
    // Optimistically bump the view count to avoid a refetch
    const request = ++detailRequestId.current;
    const bumped = { ...item, views: item.views + 1 };
    setActive(bumped);
    void markViewed(item.id);
    if (
      currentAuthUserId() &&
      item.type === 'scenario' &&
      promptKind(item.content as ScenarioContent) === 'character'
    )
      void recordCharacterDetailOpen(item.id).catch(() => undefined);
    setItems((prev) => prev.map((it) => (it.id === item.id ? bumped : it)));
    void fetchItem(item.id)
      .then((detail) => {
        if (detailRequestId.current === request) setActive({ ...detail, views: bumped.views });
      })
      .catch(() => undefined);
  }

  const activeType: ItemType = category === 'waveform' ? 'waveform' : 'scenario';
  const activeFilterCount =
    Number(discovery !== 'all') +
    Number(sort !== 'new') +
    Number(category === 'waveform' && waveformModality !== 'electrostimulation');

  const load = useCallback(() => {
    const id = ++requestId.current;
    if (requiresAccount) {
      setItems([]);
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      setNextCursor(null);
      setPageError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setLoadingMore(false);
    setNextCursor(null);
    setPageError(null);
    (discovery === 'all'
      ? fetchBrowsePage({
          type: activeType,
          kind: category === 'waveform' ? undefined : cardKind,
          modality: category === 'waveform' ? waveformModality : undefined,
          sort,
          q: q.trim() || undefined,
          limit: MARKET_PAGE_SIZE,
        })
      : fetchDiscovery(
          discovery,
          category === 'waveform' ? undefined : cardKind,
          category === 'waveform' ? 'waveform' : 'scenario',
        )
    )
      .then((result) => {
        if (id !== requestId.current) return;
        setItems(Array.isArray(result) ? result : result.items);
        setNextCursor(Array.isArray(result) ? null : result.nextCursor);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return;
        // Distinct from the empty state on purpose. Collapsing the two told
        // every user whose request failed that the market was empty and
        // invited them to upload the first item.
        setItems([]);
        setError(e instanceof Error ? e.message : '未知错误');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [activeType, cardKind, category, waveformModality, sort, q, discovery, requiresAccount]);

  const loadMore = useCallback(() => {
    if (discovery !== 'all' || nextCursor === null || loading || loadingMore) return;
    const id = ++requestId.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    setPageError(null);
    void fetchBrowsePage({
      type: activeType,
      kind: category === 'waveform' ? undefined : cardKind,
      modality: category === 'waveform' ? waveformModality : undefined,
      sort,
      q: q.trim() || undefined,
      limit: MARKET_PAGE_SIZE,
      cursor,
    })
      .then((page) => {
        if (id !== requestId.current) return;
        setItems((previous) => appendBrowsePage(previous, page.items));
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (id === requestId.current)
          setPageError(reason instanceof Error ? reason.message : '更多内容加载失败');
      })
      .finally(() => {
        if (id === requestId.current) setLoadingMore(false);
      });
  }, [
    activeType,
    cardKind,
    category,
    waveformModality,
    sort,
    q,
    discovery,
    nextCursor,
    loading,
    loadingMore,
  ]);

  useEffect(() => {
    const id = window.setTimeout(load, q ? 300 : 0);
    return () => {
      window.clearTimeout(id);
      requestId.current += 1;
    };
  }, [load, q, authRevision]);

  function openStudio(next: Studio) {
    routeRequestId.current += 1;
    detailRequestId.current += 1;
    window.history.pushState(
      null,
      '',
      marketEditorHref(
        window.location.href,
        next.kind === 'new'
          ? { kind: 'new', cardKind: next.cardKind }
          : { kind: 'edit', itemId: next.item.id },
      ),
    );
    setRouteError(null);
    setRouteBusy(false);
    setActive(null);
    setStudio(next);
  }

  function closeStudio(publishedItemId?: string) {
    const request = ++routeRequestId.current;
    const account = currentAuthUserId();
    window.history.replaceState(
      null,
      '',
      marketEditorHref(window.location.href, null, publishedItemId),
    );
    setStudio(null);
    setRouteBusy(false);
    if (publishedItemId) {
      void fetchItem(publishedItemId)
        .then((item) => {
          if (routeRequestId.current === request && currentAuthUserId() === account)
            setActive(item);
        })
        .catch(() => {
          if (routeRequestId.current === request) setLinkError('公开内容暂时无法读取');
        });
    } else {
      setActive(null);
    }
  }

  if (routeBusy) {
    return (
      <div className="mkt-scope app" role="status">
        正在打开编辑器…
      </div>
    );
  }

  if (studio) {
    return (
      <div className="mkt-scope h-full overflow-y-auto">
        <div className="app">
          <CharacterStudio
            key={studio.kind === 'new' ? `new:${studio.cardKind}` : studio.item.id}
            item={studio.kind === 'edit' ? studio.item : undefined}
            initialKind={studio.kind === 'new' ? studio.cardKind : undefined}
            onClose={() => closeStudio()}
            onSaved={(id) => {
              closeStudio(id);
              load();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mkt-scope h-full overflow-y-auto">
      <div className="app">
        {(linkError || routeError) && <p role="alert">{linkError || routeError}</p>}
        <header className="market-hero">
          <h1>发现</h1>
        </header>
        <CharacterModeration onChanged={load} />
        {discovery === 'following' && !requiresAccount && <FollowedCreators onChanged={load} />}
        {
          <section className="market-browse" aria-label="浏览公开内容">
            <div className="market-category-row">
              <nav className="market-categories" aria-label="内容分类">
                {(['character', 'scene', 'waveform'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    aria-current={category === kind ? 'page' : undefined}
                    onClick={() => {
                      setCategory(kind);
                      setOpenMenu(null);
                      if (kind !== 'waveform') setCardKind(kind);
                    }}
                  >
                    {kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '波形'}
                  </button>
                ))}
              </nav>
              <div className="market-row-actions">
                {shellNav ? (
                  // Games live under 发现 rather than as a separate top-level module.
                  <Button size="sm" variant="ghost" onClick={() => shellNav.navigate('playground')}>
                    <Gamepad2 className="h-4 w-4" /> 游戏
                  </Button>
                ) : null}
                <div className="market-create" ref={createMenuRef}>
                  <Button
                    size="sm"
                    aria-expanded={openMenu === 'create'}
                    aria-controls="market-create-menu"
                    onClick={() => setOpenMenu((open) => (open === 'create' ? null : 'create'))}
                  >
                    <Plus className="h-4 w-4" /> 创建
                  </Button>
                  {openMenu === 'create' && (
                    <div
                      id="market-create-menu"
                      className="market-create-menu"
                      role="group"
                      aria-label="创建内容"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          if (inShell && !signedIn) return openShellSettings('account');
                          openStudio({ kind: 'new', cardKind: 'character' });
                        }}
                      >
                        创建角色
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          if (inShell && !signedIn) return openShellSettings('account');
                          openStudio({ kind: 'new', cardKind: 'scene' });
                        }}
                      >
                        创建场景
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          if (inShell && !signedIn) return openShellSettings('account');
                          setUploading(true);
                        }}
                      >
                        发布波形
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {
              <div className="market-controls">
                {discovery === 'all' ? (
                  <label className="market-search">
                    <Search className="h-4 w-4" aria-hidden="true" />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="搜索名称、简介或标签"
                      aria-label="搜索公开内容"
                    />
                  </label>
                ) : (
                  <button
                    type="button"
                    className="market-scope-chip"
                    aria-label={`正在查看${discovery === 'favorites' ? '我的收藏' : '关注作者'}，点击回到全部`}
                    onClick={() => setDiscovery('all')}
                  >
                    {discovery === 'favorites' ? '我的收藏' : '关注作者'}
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                <div className="market-filter" ref={filterMenuRef}>
                  <button
                    type="button"
                    ref={filterTriggerRef}
                    className="market-filter-trigger"
                    aria-expanded={openMenu === 'filters'}
                    aria-controls="market-filter-panel"
                    onClick={() => setOpenMenu((open) => (open === 'filters' ? null : 'filters'))}
                  >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    筛选
                    {activeFilterCount > 0 && (
                      <span
                        className="market-filter-count"
                        aria-label={`已选 ${activeFilterCount} 项筛选`}
                      >
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                  {openMenu === 'filters' && (
                    <div
                      id="market-filter-panel"
                      className="market-filter-panel"
                      data-placement={filterPosition?.side ?? 'bottom'}
                      style={
                        filterPosition ? { maxHeight: `${filterPosition.maxHeight}px` } : undefined
                      }
                      role="region"
                      aria-label="内容筛选"
                    >
                      <div className="market-filter-head">
                        <strong>筛选内容</strong>
                        <button
                          type="button"
                          aria-label="关闭筛选"
                          onClick={() => {
                            setOpenMenu(null);
                            filterTriggerRef.current?.focus();
                          }}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <fieldset className="market-filter-group">
                        <legend>范围</legend>
                        <div className="market-filter-options">
                          {(['all', 'favorites', 'following'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              aria-pressed={discovery === mode}
                              onClick={() => setDiscovery(mode)}
                            >
                              {mode === 'all'
                                ? '全部'
                                : mode === 'favorites'
                                  ? '我的收藏'
                                  : '关注作者'}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      <fieldset className="market-filter-group">
                        <legend>排序方式</legend>
                        <div className="market-filter-options">
                          {sortOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              aria-pressed={sort === option.value}
                              onClick={() => setSort(option.value)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      {category === 'waveform' && (
                        <fieldset className="market-filter-group">
                          <legend>波形类型</legend>
                          <div className="market-filter-options">
                            <button
                              type="button"
                              aria-pressed={waveformModality === 'electrostimulation'}
                              onClick={() => setWaveformModality('electrostimulation')}
                            >
                              电击波形
                            </button>
                            <button
                              type="button"
                              aria-pressed={waveformModality === 'vibration'}
                              onClick={() => setWaveformModality('vibration')}
                            >
                              震动波形
                            </button>
                          </div>
                        </fieldset>
                      )}
                      <button
                        type="button"
                        className="market-filter-reset"
                        disabled={activeFilterCount === 0}
                        onClick={() => {
                          setDiscovery('all');
                          setSort('new');
                          setWaveformModality('electrostimulation');
                        }}
                      >
                        重置筛选
                      </button>
                    </div>
                  )}
                </div>
              </div>
            }
          </section>
        }

        <main className="market-grid">
          {requiresAccount ? (
            <div className="empty">
              <strong>登录后继续发现</strong>
              <span>收藏和关注作者会随账号同步。</span>
              <button className="btn" onClick={() => openShellSettings('account')}>
                登录 / 注册
              </button>
            </div>
          ) : loading ? (
            <p role="status" aria-live="polite" className="empty">
              加载中…
            </p>
          ) : error ? (
            <div role="alert" className="empty">
              <p>没能加载市场内容</p>
              <p className="error">{error}</p>
              <button className="btn" onClick={load}>
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="empty">
              <strong>
                {discovery === 'favorites'
                  ? '还没有收藏的内容'
                  : discovery === 'following'
                    ? '还没有关注作者的内容'
                    : q.trim()
                      ? '没有找到相关内容'
                      : `还没有公开${category === 'waveform' ? '波形' : cardKind === 'character' ? '角色' : '场景'}`}
              </strong>
              <span>
                {discovery === 'favorites'
                  ? '浏览公开内容，收藏喜欢的作品。'
                  : discovery === 'following'
                    ? '浏览公开内容，关注喜欢的作者。'
                    : q.trim()
                      ? '试试其他关键词，或切换内容分类。'
                      : '新的创作发布后会出现在这里。'}
              </span>
            </div>
          ) : (
            items.map((item) => <ItemCard key={item.id} item={item} onOpen={openItem} />)
          )}
        </main>
        {discovery === 'all' && !loading && !error && items.length > 0 && (
          <div className="market-pagination">
            {pageError && <p role="alert">更多内容加载失败：{pageError}</p>}
            {sort !== 'new' && nextCursor !== null && (
              <p>热度与浏览量实时变化，跨页顺序可能改变；刷新可查看最新排序。</p>
            )}
            {nextCursor !== null && (
              <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? '加载中…' : pageError ? '重试加载' : '浏览更多'}
              </button>
            )}
          </div>
        )}

        {active && (
          <ItemDetail
            key={active.id}
            item={active}
            onImportScene={shellNav ? (item) => importSceneCard(item.id) : undefined}
            onStartCharacter={
              shellNav
                ? async (item) => {
                    const account = currentAuthUserId();
                    if (!account) {
                      openShellSettings('account');
                      return;
                    }
                    await startCharacterChat(item.id);
                    if (currentAuthUserId() !== account)
                      throw new Error('账号已切换，请重新打开公开内容');
                    shellNav.navigate('agent');
                  }
                : undefined
            }
            onClose={() => {
              detailRequestId.current += 1;
              if (new URLSearchParams(window.location.search).has('item'))
                window.history.replaceState(null, '', marketEditorHref(window.location.href, null));
              setActive(null);
            }}
            onUpdated={(updated) => {
              setActive(updated);
              setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
            }}
            onDeleted={(id) => setItems((prev) => prev.filter((item) => item.id !== id))}
            onEditCharacter={(item) => {
              const account = currentAuthUserId();
              const request = ++detailRequestId.current;
              void fetchItem(item.id)
                .then((detail) => {
                  if (detailRequestId.current !== request || account !== currentAuthUserId())
                    return;
                  openStudio({ kind: 'edit', item: detail });
                })
                .catch((reason: unknown) => {
                  if (detailRequestId.current === request)
                    setLinkError(reason instanceof Error ? reason.message : '公开内容读取失败');
                });
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
      </div>
    </div>
  );
}
