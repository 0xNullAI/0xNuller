import { AssistantAvatar } from './AssistantAvatar.js';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type Ref,
  type ReactNode,
} from 'react';
import { ArrowLeft, Check, ChevronRight, Heart, Store } from 'lucide-react';
import {
  currentAuthUserId,
  subscribeAuthChanges,
  listCharacterRelationships,
  ensureCharacterRelationship,
} from '@0xnullai/auth';
import {
  deviceConversationAccess,
  setDeviceConversationAccess,
  subscribeDeviceConversationAccess,
} from '@0xnullai/settings';
import {
  Button,
  ConversationHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  MarketImportDialog,
  ModuleSettingsSection,
  useInShell,
  useSettingsSubpage,
  useOpenShellSettings,
} from '@0xnullai/ui';
import type { MarketItem } from '@0xnullai/market-client';
import { RelationshipPanel } from './RelationshipPanel';
import { AdvancedSettingsArea } from './AdvancedSettings';
const MemoryReviewPanel = lazy(() =>
  import('./MemoryReviewPanel').then((m) => ({ default: m.MemoryReviewPanel })),
);
const MemoryFactTools = lazy(() =>
  import('./MemoryFactTools').then((m) => ({ default: m.MemoryFactTools })),
);
const CompanionLifePanel = lazy(() =>
  import('./CompanionLifePanel').then((m) => ({ default: m.CompanionLifePanel })),
);
const CompanionSchedulePanel = lazy(() =>
  import('./CompanionSchedulePanel').then((m) => ({ default: m.CompanionSchedulePanel })),
);
const AgentWorkspacePanel = lazy(() =>
  import('./AgentWorkspacePanel').then((m) => ({ default: m.AgentWorkspacePanel })),
);
const CharacterAppearancePanel = lazy(() =>
  import('./CharacterAppearancePanel').then((m) => ({ default: m.CharacterAppearancePanel })),
);
const CompanionMediaPanel = lazy(() =>
  import('./CompanionMediaPanel').then((m) => ({ default: m.CompanionMediaPanel })),
);
const subscribe = (notify: () => void) => subscribeAuthChanges(() => notify());
interface Props {
  ref?: Ref<RelationshipAccessHandle>;
  characterId: string;
  characterName: string;
  marketPortraitId?: string;
  conversationId?: string;
  /** Phone-width shell: back to the conversation list from this header. */
  onBack?: () => void;
  /** The character's emoji, shown when no portrait is chosen. */
  characterIcon?: string;
  /** Imported scene cards that can frame this chat; applying one never changes the character. */
  scenes?: { id: string; name: string; icon?: string }[];
  sceneId?: string | null;
  onSceneChange?: (id: string | null) => void;
  onImportScene?: (item: MarketItem) => void;
}
export interface RelationshipAccessHandle {
  openMedia: () => void;
}
/** Conversation header + a settings page owned by the selected private relationship. */
export function RelationshipAccess({
  ref,
  characterId,
  characterName,
  marketPortraitId,
  conversationId,
  onBack,
  characterIcon,
  scenes = [],
  sceneId = null,
  onSceneChange,
  onImportScene,
}: Props) {
  const [sceneImportOpen, setSceneImportOpen] = useState(false);
  const accountId = useSyncExternalStore(subscribe, currentAuthUserId, () => null);
  const inShell = useInShell();
  const openSettings = useOpenShellSettings();
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<{
    owner: string;
    page: string | null;
    revision: number;
  }>({
    owner: '',
    page: null,
    revision: 0,
  });
  const identity = `${accountId}:${characterId}`;
  const [nickname, setNickname] = useState<{
    identity: string;
    name: string;
    relationshipId: string | null;
  } | null>(null);
  const deviceAllowed = useSyncExternalStore(
    subscribeDeviceConversationAccess,
    () => deviceConversationAccess(accountId, 'ai', conversationId ?? ''),
    () => false,
  );
  const [deviceAccessError, setDeviceAccessError] = useState('');
  useEffect(() => {
    if (!accountId || !characterId) return;
    let active = true;
    void listCharacterRelationships(characterId)
      .then(async ({ items }) => {
        let relationship = items[0] ?? null;
        if (!relationship && active) {
          try {
            relationship = (await ensureCharacterRelationship(characterId)).item;
          } catch {
            // A deleted relationship is deliberately not recreated in the background.
          }
        }
        if (active)
          setNickname({
            identity,
            name: relationship?.aiNickname ?? '',
            relationshipId: relationship?.id ?? null,
          });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [accountId, characterId, identity]);
  const displayName =
    nickname?.identity === identity && nickname.name ? nickname.name : characterName;
  const relationshipId = nickname?.identity === identity ? nickname.relationshipId : null;
  useImperativeHandle(
    ref,
    () => ({
      openMedia: () => {
        setSettingsView((current) => ({
          owner: identity,
          page: 'media',
          revision: current.revision + 1,
        }));
        if (inShell) openSettings('agent-companion');
        else setStandaloneOpen(true);
      },
    }),
    [identity, inShell, openSettings],
  );
  const settingsBody = (
    <RelationshipSettingsPages
      key={`${identity}:${conversationId ?? ''}:${settingsView.revision}`}
      initialPage={settingsView.owner === identity ? settingsView.page : null}
      title={displayName}
      accountId={accountId}
      onAccount={() => {
        setStandaloneOpen(false);
        openSettings('account');
      }}
      pages={[
        {
          id: 'relationship',
          group: '角色与关系',
          title: '称呼与关系',
          unavailable: !accountId ? '登录后可设置' : undefined,
          content: (
            <RelationshipPanel
              key={identity}
              characterId={characterId}
              characterName={characterName}
              onChange={(relationship) =>
                setNickname({
                  identity,
                  name: relationship?.aiNickname ?? '',
                  relationshipId: relationship?.id ?? null,
                })
              }
            />
          ),
        },
        {
          id: 'memory',
          group: '角色与关系',
          title: '记忆',
          advanced: true,
          unavailable: !relationshipId ? '先保存专属关系' : undefined,
          content:
            accountId && relationshipId ? (
              <>
                <MemoryReviewPanel
                  key={`memory:${accountId}:${relationshipId}`}
                  relationshipId={relationshipId}
                  conversationId={conversationId}
                />
                <MemoryFactTools relationshipId={relationshipId} />
                <CompanionLifePanel
                  key={`life:${accountId}:${relationshipId}`}
                  accountId={accountId}
                  relationshipId={relationshipId}
                />
              </>
            ) : null,
        },
        ...(onSceneChange
          ? [
              {
                id: 'scene',
                group: '角色与关系',
                title: '场景',
                detail: scenes.find((scene) => scene.id === sceneId)?.name ?? '无场景',
                unavailable: !characterId ? '先选择角色' : undefined,
                content: (
                  <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)]">
                    {[{ id: null, name: '无场景', icon: undefined }, ...scenes].map((scene) => (
                      <button
                        key={scene.id ?? 'none'}
                        type="button"
                        aria-pressed={scene.id === sceneId}
                        onClick={() => onSceneChange(scene.id)}
                        className="flex min-h-11 w-full items-center gap-3 border-b border-[var(--surface-border)] px-4 text-left last:border-b-0 hover:bg-[var(--bg-soft)]"
                      >
                        {scene.icon ? <span aria-hidden>{scene.icon}</span> : null}
                        <span className="min-w-0 flex-1 truncate">{scene.name}</span>
                        {scene.id === sceneId && <Check className="h-4 w-4" aria-hidden />}
                      </button>
                    ))}
                    {onImportScene && (
                      <button
                        type="button"
                        onClick={() => setSceneImportOpen(true)}
                        className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
                      >
                        <Store className="h-4 w-4" aria-hidden />从 Market 导入场景
                      </button>
                    )}
                  </div>
                ),
              },
            ]
          : []),
        {
          id: 'appearance',
          group: '角色与关系',
          title: '头像与形象',
          advanced: true,
          unavailable: !relationshipId ? '先保存专属关系' : undefined,
          content: relationshipId ? (
            <CharacterAppearancePanel
              key={`${accountId}:${relationshipId}`}
              relationshipId={relationshipId}
            />
          ) : null,
        },
        {
          id: 'schedule',
          group: '聊天功能',
          title: '定时消息',
          advanced: true,
          unavailable: !relationshipId
            ? '先保存专属关系'
            : !conversationId
              ? '开始聊天后可设置'
              : undefined,
          content:
            accountId && relationshipId && conversationId ? (
              <CompanionSchedulePanel
                key={`${accountId}:${relationshipId}:${conversationId}`}
                accountId={accountId}
                relationshipId={relationshipId}
                conversationId={conversationId}
              />
            ) : null,
        },
        {
          id: 'workspace',
          group: '聊天功能',
          title: '任务与文件',
          advanced: true,
          unavailable: !relationshipId
            ? '先保存专属关系'
            : !conversationId
              ? '开始聊天后可设置'
              : undefined,
          content: conversationId ? (
            <AgentWorkspacePanel
              key={`${accountId}:${conversationId}`}
              conversationId={conversationId}
            />
          ) : null,
        },
        {
          id: 'media',
          group: '聊天功能',
          title: '图片与视频',
          unavailable: !relationshipId
            ? '先保存专属关系'
            : !conversationId
              ? '开始聊天后可设置'
              : undefined,
          content:
            accountId && relationshipId && conversationId ? (
              <CompanionMediaPanel
                key={`${accountId}:${relationshipId}:${conversationId}`}
                accountId={accountId}
                relationshipId={relationshipId}
                conversationId={conversationId}
              />
            ) : null,
        },
        {
          id: 'device',
          group: '设备',
          title: '设备权限',
          detail: deviceAllowed ? '已允许' : '未允许',
          content: (
            <section aria-label="本聊天的设备权限" className="space-y-2">
              {accountId && conversationId ? (
                <label className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
                  允许这段聊天控制设备
                  <input
                    type="checkbox"
                    checked={deviceAllowed}
                    onChange={(event) => {
                      const saved = setDeviceConversationAccess(
                        accountId,
                        'ai',
                        conversationId,
                        event.target.checked,
                      );
                      setDeviceAccessError(saved ? '' : '无法保存授权，请检查浏览器存储');
                    }}
                  />
                </label>
              ) : (
                <p>登录并开始聊天后才能开启。</p>
              )}
              <p className="px-1 text-xs text-[var(--text-faint)]">停止始终可用。</p>
              {deviceAccessError && (
                <p role="alert" className="text-[var(--danger)]">
                  {deviceAccessError}
                </p>
              )}
            </section>
          ),
        },
      ]}
    />
  );
  const open = (page: string | null = null) => {
    setSettingsView((current) => ({ owner: identity, page, revision: current.revision + 1 }));
    if (inShell) openSettings('agent-companion');
    else setStandaloneOpen(true);
  };
  return (
    <>
      <ConversationHeader>
        {onBack ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={onBack}
            aria-label="返回消息"
            title="返回消息"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        ) : null}
        <button
          type="button"
          onClick={() => open()}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-full text-left"
          aria-label={`${displayName} · 聊天设置`}
        >
          <AssistantAvatar
            name={displayName}
            icon={characterIcon}
            marketPortraitId={marketPortraitId}
            relationshipId={relationshipId}
            size="md"
          />
          <strong className="block min-w-0 truncate text-sm">{displayName}</strong>
        </button>
      </ConversationHeader>
      {onImportScene && (
        <MarketImportDialog
          open={sceneImportOpen}
          onOpenChange={setSceneImportOpen}
          type="scenario"
          onImport={(item) => {
            onImportScene(item);
            setSceneImportOpen(false);
          }}
        />
      )}
      <ModuleSettingsSection id="agent-companion" label="聊天与角色" icon={Heart} order={25}>
        {settingsBody}
      </ModuleSettingsSection>
      {!inShell && (
        <Dialog open={standaloneOpen} onOpenChange={setStandaloneOpen}>
          <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>聊天与角色</DialogTitle>
              <DialogDescription>管理这段私人聊天的设置。</DialogDescription>
            </DialogHeader>
            {settingsBody}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

interface RelationshipSettingsPage {
  id: string;
  group: string;
  title: string;
  /** Current value only (场景、设备权限); rows carry no descriptions. */
  detail?: string;
  unavailable?: string;
  /** The page ends with one flat 高级 section that its panels fill. */
  advanced?: boolean;
  content: ReactNode;
}

/** A single detail page is mounted at a time; switching identities remounts this navigator. */
function RelationshipSettingsPages({
  title,
  accountId,
  initialPage,
  pages,
  onAccount,
}: {
  title: string;
  accountId: string | null;
  initialPage: string | null;
  pages: RelationshipSettingsPage[];
  onAccount: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialPage);
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => node?.focus(), []);
  const selected = pages.find((page) => page.id === selectedId && !page.unavailable);
  const closeSelected = useCallback(() => setSelectedId(null), []);
  const sharedHeader = useSettingsSubpage(
    selected ? { title: selected.title, onBack: closeSelected } : null,
  );
  if (selected)
    return (
      <section
        className="mx-auto w-full min-w-0 max-w-2xl space-y-5 text-sm"
        aria-label={selected.title}
      >
        {sharedHeader ? (
          // The settings panel header already shows this title and its back arrow.
          <h2 key={selected.id} tabIndex={-1} ref={focusHeading} className="sr-only">
            {selected.title}
          </h2>
        ) : (
          <div className="flex min-w-0 items-center gap-3 border-b border-[var(--surface-border)] pb-3">
            <Button size="sm" variant="ghost" onClick={closeSelected} aria-label="返回聊天设置">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Button>
            <h2
              key={selected.id}
              tabIndex={-1}
              ref={focusHeading}
              className="min-w-0 flex-1 text-base font-semibold outline-none"
            >
              {selected.title}
            </h2>
          </div>
        )}
        <p className="text-xs text-[var(--text-faint)]">
          {title} · {selected.detail}
        </p>
        <div className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
          <Suspense fallback={<p role="status">正在读取…</p>}>
            {selected.advanced ? (
              <AdvancedSettingsArea>{selected.content}</AdvancedSettingsArea>
            ) : (
              selected.content
            )}
          </Suspense>
        </div>
      </section>
    );
  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl space-y-6 text-sm">
      <h2 className="px-1 text-xl font-semibold tracking-tight">{title}</h2>
      {!accountId && (
        <div className="rounded-2xl bg-[var(--bg-elevated)] p-4">
          <p className="mb-3">登录后可保存专属关系与跨端聊天记录。</p>
          <Button size="sm" onClick={onAccount}>
            登录 / 注册
          </Button>
        </div>
      )}
      {['角色与关系', '聊天功能', '设备'].map((group) => (
        <section key={group} aria-label={group}>
          <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)]">
            {pages
              .filter((page) => page.group === group)
              .map((page) => (
                <SettingsRow
                  key={page.id}
                  title={page.title}
                  detail={page.unavailable ?? page.detail}
                  disabled={Boolean(page.unavailable)}
                  onClick={() => setSelectedId(page.id)}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
function SettingsRow({
  title,
  detail,
  disabled,
  onClick,
}: {
  title: string;
  /** A current value (场景、设备权限) or why it is unavailable — never a description. */
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-12 w-full min-w-0 items-center gap-3 border-b border-[var(--surface-border)] px-4 py-2.5 text-left last:border-b-0 hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-default disabled:opacity-50"
    >
      <span className="min-w-0 flex-1 font-medium">{title}</span>
      {detail && (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--text-faint)]">
          {detail}
        </span>
      )}
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
    </button>
  );
}
