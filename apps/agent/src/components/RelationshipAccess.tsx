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
import { ArrowLeft, ChevronRight, Heart, Settings2 } from 'lucide-react';
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
  ModuleSettingsSection,
  useInShell,
  useSettingsSubpage,
  useOpenShellSettings,
} from '@0xnullai/ui';
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
}: Props) {
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
      onScenes={inShell ? () => openSettings('scenes') : undefined}
      pages={[
        {
          id: 'relationship',
          group: '角色与关系',
          title: '专属称呼与关系',
          detail: 'AI 的名字、对你的称呼与相处方式',
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
          title: '关系记忆与重要人物',
          detail: '共同经历、长期记忆和重要的人',
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
        {
          id: 'appearance',
          group: '角色与关系',
          title: '角色形象与手绘头像',
          detail: '选择形象，或亲手给 AI 画头像',
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
          title: '定时联系与通知',
          detail: '设置主动联系的时间与方式',
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
          detail: '管理这段聊天的任务与资料',
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
          title: '生成图片与视频',
          detail: '创作图片，查看媒体任务',
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
          title: '本聊天的设备权限',
          detail: deviceAllowed ? '已允许请求设备控制' : '未允许请求设备控制',
          content: (
            <section
              aria-label="本聊天的设备权限"
              className="rounded border border-[var(--surface-border)] p-3"
            >
              <h3 className="font-medium">本聊天的设备权限</h3>
              <p className="my-2 text-xs text-[var(--text-soft)]">
                开启后本聊天可请求控制设备，停止始终可用。
              </p>
              {accountId && conversationId ? (
                <label className="flex items-center gap-2">
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
                  允许这段聊天请求设备控制
                </label>
              ) : (
                <p>登录并开始聊天后才能开启。</p>
              )}
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
          onClick={() => open('appearance')}
          className="shrink-0 rounded-full"
          aria-label={`更换${displayName}的头像`}
          title="更换头像"
        >
          <AssistantAvatar
            name={displayName}
            icon={characterIcon}
            marketPortraitId={marketPortraitId}
            relationshipId={relationshipId}
            size="md"
          />
        </button>
        <button
          type="button"
          onClick={() => open()}
          className="min-w-0 flex-1 text-left"
          aria-label={`打开${displayName}的聊天设置`}
        >
          <strong className="block truncate text-sm">{displayName}</strong>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => open()}
            aria-label="聊天设置"
            title="聊天设置"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </ConversationHeader>
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
  detail: string;
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
  onScenes,
}: {
  title: string;
  accountId: string | null;
  initialPage: string | null;
  pages: RelationshipSettingsPage[];
  onAccount: () => void;
  onScenes?: () => void;
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
      <div className="px-1">
        <h2 className="text-xl font-semibold tracking-tight">{title} · 聊天设置</h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-faint)]">
          管理这段聊天的关系、形象与功能。
        </p>
      </div>
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
          <h3 className="mb-2 px-3 text-xs font-medium text-[var(--text-faint)]">{group}</h3>
          <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)]">
            {group === '角色与关系' && onScenes && (
              <SettingsRow title="角色卡与设定" detail="为新聊天选择角色" onClick={onScenes} />
            )}
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
      <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--bg-elevated)]">
        <SettingsRow
          title="个人资料与 Credit"
          detail="管理跨角色资料和账户余额"
          onClick={onAccount}
        />
      </div>
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
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-16 w-full min-w-0 items-center gap-3 border-b border-[var(--surface-border)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--bg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-default disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-faint)]">
          {detail}
        </span>
      </span>
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
    </button>
  );
}
