import { GroupMembershipDialog } from './GroupMembershipDialog';
import type { ChatReplyContext } from '../lib/protocol';
import { ConversationHeader, ConversationTitle, useShellNav } from '@0xnullai/ui';
import { ArrowLeft, Bot, ChevronRight, LogOut, Search, Settings2, Users } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import type { DmRequest } from '@0xnullai/auth';
import type { useDevice } from '@0xnullai/device-runtime';
import type { useWaveforms } from '@0xnullai/waveforms';
import type { usePeerRoom } from '../hooks/use-peer-room';
import type { CmdAction, DeviceCommand, MemberState, PlayMode } from '../lib/protocol';
import { ChatPanel } from './ChatPanel';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ControlPanel } from './ControlPanel';
import { CreateRoomDialog } from './CreateRoomDialog';
import { DeviceSafetyButton } from './DeviceSafetyButton';
import { RoomAgentDialog } from './RoomAgentDialog';
import { ShellDmList } from './ShellDmList';
import { ShellRoomList } from './ShellRoomList';

type PeerRoom = ReturnType<typeof usePeerRoom>;
type Device = ReturnType<typeof useDevice>;
type Waveforms = ReturnType<typeof useWaveforms>;

interface DmPeer {
  id: string;
  name: string;
  room: string;
}

export function roomPresenceLabel(isDm: boolean, peerCount: number): string {
  if (peerCount === 0) return isDm ? '对方不在线' : '1 人在线 · 等待成员';
  return isDm ? '对方在线' : `${peerCount + 1} 人在线`;
}

const SETTINGS_ROW =
  'ui-press-row flex min-h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-[var(--text)] hover:bg-[var(--bg-soft)]';

export function leaveChatRoom(
  releaseDevice: () => void,
  leave: () => void,
  clearDmPeer: () => void,
): void {
  // Preserve the safety-sensitive ordering: stop output before leaving the transport, then
  // clear the local DM header only after both lifecycle operations were requested. The BLE
  // links are shared with the other modules and stay up.
  releaseDevice();
  leave();
  clearDmPeer();
}

export interface ChatAppViewProps {
  signedIn: boolean;
  accountRequired: boolean;
  createRoomOpen: boolean;
  setCreateRoomOpen: Dispatch<SetStateAction<boolean>>;
  displayName: string;
  username: string | null;
  dmPeer: DmPeer | null;
  setDmPeer: Dispatch<SetStateAction<DmPeer | null>>;
  dmError: string | null;
  onGroupMessageVisible?: (id: string, stillVisible: () => boolean) => Promise<void>;
  onDmMessageVisible?: (id: string, stillVisible: () => boolean) => Promise<void>;
  activeTab: 'chat' | 'control';
  setActiveTab: Dispatch<SetStateAction<'chat' | 'control'>>;
  agentOpen: boolean;
  setAgentOpen: Dispatch<SetStateAction<boolean>>;
  inShell: boolean;
  conversationDeviceEnabled: boolean;
  onSetConversationDeviceEnabled: (enabled: boolean) => void;
  allowAi: boolean;
  setAllowAi: Dispatch<SetStateAction<boolean>>;
  peerRoom: PeerRoom;
  device: Device;
  waveforms: Waveforms;
  queueA: string[];
  queueB: string[];
  playModeA: PlayMode;
  playModeB: PlayMode;
  intervalASec: number;
  intervalBSec: number;
  currentIndexA: number;
  currentIndexB: number;
  firingA: boolean;
  firingB: boolean;
  showChat: () => void;
  requireAccount: () => boolean;
  openDm: (request: DmRequest) => Promise<void>;
  openAiSettings: () => void;
  openMemorySettings?: (kind: 'dm' | 'group', id: string) => void;
  sendMedia: (
    blob: Blob,
    kind: 'image' | 'audio',
    meta?: { durationMs?: number; w?: number; h?: number },
    reply?: ChatReplyContext,
  ) => Promise<void>;
  sendCommand: (target: string, action: CmdAction, params?: Omit<DeviceCommand, 'action'>) => void;
}

/**
 * Presentation-only composition for Chat's room directory, room header and two-panel workspace.
 * Transport, authorization, lease checks and command ordering stay in App; this component only
 * invokes the already-validated callbacks it receives.
 */
export function ChatAppView({
  signedIn,
  accountRequired,
  createRoomOpen,
  setCreateRoomOpen,
  displayName,
  username,
  dmPeer,
  setDmPeer,
  dmError,
  onDmMessageVisible,
  onGroupMessageVisible,
  activeTab,
  setActiveTab,
  agentOpen,
  setAgentOpen,
  inShell,
  conversationDeviceEnabled,
  onSetConversationDeviceEnabled,
  allowAi,
  setAllowAi,
  peerRoom,
  device,
  waveforms,
  queueA,
  queueB,
  playModeA,
  playModeB,
  intervalASec,
  intervalBSec,
  currentIndexA,
  currentIndexB,
  firingA,
  firingB,
  showChat,
  requireAccount,
  openDm,
  openAiSettings,
  openMemorySettings,
  sendMedia,
  sendCommand,
}: ChatAppViewProps) {
  const shellNav = useShellNav();
  const [membersOpen, setMembersOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);
  const [conversationListOpen, setConversationListOpen] = useState(false);
  const roomTitle = peerRoom.isDm ? (dmPeer?.name ?? '私聊') : peerRoom.groupName || '群聊';
  const leaveRoom = () => {
    leaveChatRoom(device.release, peerRoom.leave, () => setDmPeer(null));
  };

  return (
    <div className="flex h-full min-h-0 bg-[var(--bg)]">
      {!inShell && (
        <aside
          aria-label="聊天会话"
          className={`${conversationListOpen || !peerRoom.roomId ? 'flex' : 'hidden'} w-full shrink-0 flex-col overflow-y-auto border-r border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3 md:flex md:w-64 xl:w-72`}
        >
          <h2 className="px-2 py-3 text-lg font-semibold">聊天</h2>
          {signedIn && (
            <section aria-label="个人聊天">
              <h3 className="px-2 py-2 text-xs text-[var(--text-faint)]">个人聊天</h3>
              <ShellDmList
                currentRoom={peerRoom.isDm ? peerRoom.roomId : null}
                onOpen={(peer) => {
                  setConversationListOpen(false);
                  showChat();
                  void openDm({
                    accountId: peer.id,
                    username: peer.username,
                    displayName: peer.displayName,
                  });
                }}
              />
            </section>
          )}

          <section aria-label="群聊" className="mt-3">
            <h3 className="px-2 py-2 text-xs text-[var(--text-faint)]">群聊</h3>
            <ShellRoomList
              currentRoom={peerRoom.isDm ? null : peerRoom.roomId}
              onJoin={(code) => {
                if (!requireAccount()) return;
                setConversationListOpen(false);
                showChat();
                setDmPeer(null);
                peerRoom.join(code);
              }}
              onCreate={() => {
                if (!requireAccount()) return;
                setConversationListOpen(false);
                showChat();
                setCreateRoomOpen(true);
              }}
              onDelete={(code) => {
                if (peerRoom.roomId === code) peerRoom.leave();
              }}
            />
          </section>
        </aside>
      )}
      <div
        className={`${!inShell && (conversationListOpen || !peerRoom.roomId) ? 'hidden md:flex' : 'flex'} min-h-0 min-w-0 flex-1 flex-col`}
      >
        {accountRequired && !signedIn ? (
          <div
            role="alert"
            className="mx-3 mb-2 rounded-[var(--radius-sm)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--text-soft)]"
          >
            登录后才能创建、加入群聊或发起私聊；公开群仍可浏览。
          </div>
        ) : null}

        {createRoomOpen && (
          <CreateRoomDialog
            ownerName={displayName}
            onCreate={(code, options) => peerRoom.join(code, { ...options, claim: true })}
            onJoin={(code) => peerRoom.join(code)}
            onClose={() => setCreateRoomOpen(false)}
          />
        )}

        <ConversationHeader>
          {shellNav?.conversationBack ? (
            <button
              type="button"
              className="ui-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
              onClick={shellNav.conversationBack}
              aria-label="返回消息"
              title="返回消息"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : null}
          {!inShell && (
            <button
              type="button"
              className="shrink-0 p-2 text-xs md:hidden"
              onClick={() => setConversationListOpen(true)}
              aria-label="返回会话列表"
            >
              会话
            </button>
          )}
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-base"
          >
            {roomTitle.slice(0, 1)}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ConversationTitle>{roomTitle}</ConversationTitle>
            {dmError && (
              <span className="min-w-0 shrink truncate rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-xs text-[var(--danger)]">
                {dmError}
              </span>
            )}
          </div>
          {!inShell && (
            <div className="flex shrink-0 items-center gap-1">
              {!peerRoom.isDm && (
                <>
                  {peerRoom.canManageGroup && (
                    <button
                      onClick={() => setAgentOpen(true)}
                      className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] transition-colors hover:bg-[var(--bg-soft)] ${peerRoom.agent ? 'text-[var(--accent)]' : 'text-[var(--text-soft)]'}`}
                      title={peerRoom.agent ? `群 AI：${peerRoom.agent.name}` : '给群加个 AI'}
                    >
                      <Bot className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={openAiSettings}
                    className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
                    title="AI 设置"
                  >
                    <Settings2 className="h-4 w-4" />
                  </button>
                </>
              )}
              <DeviceSafetyButton
                connected={device.connected}
                deviceName={device.deviceInfo?.name ?? null}
                battery={device.battery}
                limitA={device.limitA}
                limitB={device.limitB}
                onSetLimit={device.setLimit}
                onRestoreDefaults={waveforms.restoreDefaults}
                sensor={device.sensor}
                opossum={device.opossum}
                onConnectDevice={device.connectDevice}
                deviceLink={device.deviceLink}
                onSetDeviceLink={device.setDeviceLink}
              />
              {(device.connected || device.opossum?.connected) && (
                <button
                  onClick={device.stopAll}
                  className="flex h-9 items-center gap-1 rounded-[var(--radius-ctl)] bg-[var(--danger-soft)] px-2.5 text-xs font-medium text-[var(--danger)] transition-opacity hover:opacity-80"
                  title="紧急停止"
                >
                  <span aria-hidden>⏹</span>
                  <span className="hidden sm:inline">停止</span>
                </button>
              )}
              <button
                onClick={leaveRoom}
                className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--danger)]"
                title={peerRoom.isDm ? '关闭私聊' : '退出群聊'}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
          {inShell && peerRoom.roomId && (
            <button
              type="button"
              onClick={() => setActiveTab(activeTab === 'chat' ? 'control' : 'chat')}
              className="ui-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              aria-label={activeTab === 'chat' ? '聊天设置' : '返回聊天'}
            >
              {activeTab === 'chat' ? (
                <Settings2 className="h-5 w-5" />
              ) : (
                <ArrowLeft className="h-5 w-5" />
              )}
            </button>
          )}
        </ConversationHeader>
        {searchOpen && peerRoom.roomId && (
          <ChatSearchDialog
            onSearch={peerRoom.searchMessages}
            onPick={(id) => {
              setSearchOpen(false);
              setActiveTab('chat');
              setJumpToMessageId(id);
            }}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {membersOpen && !peerRoom.isDm && peerRoom.isOwner && (
          <GroupMembershipDialog
            key={peerRoom.roomId}
            members={peerRoom.groupMemberships}
            onAction={peerRoom.manageGroupMembership}
            onClose={() => setMembersOpen(false)}
          />
        )}

        {peerRoom.roomId &&
          !peerRoom.isDm &&
          !peerRoom.persistentHistory &&
          peerRoom.canManageGroup && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--surface-border)] px-3 py-2 text-xs">
              <span>此旧群仍使用限量历史。</span>
              <button
                type="button"
                onClick={peerRoom.keepGroupHistory}
                className="shrink-0 text-[var(--accent)]"
              >
                升级为长期群
              </button>
            </div>
          )}
        {!peerRoom.roomId ? (
          <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
            <div className="mx-auto w-full max-w-2xl rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 sm:p-6">
              <h2 className="text-lg font-semibold">公开群</h2>
              <div className="mt-3">
                <ShellRoomList
                  mode="directory"
                  currentRoom={null}
                  onJoin={(code) => {
                    if (requireAccount()) peerRoom.join(code);
                  }}
                  onCreate={() => {
                    if (requireAccount()) setCreateRoomOpen(true);
                  }}
                  onDelete={() => undefined}
                />
              </div>
            </div>
          </main>
        ) : (
          <>
            {!inShell && (
              <div className="flex shrink-0 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)]">
                <button
                  onClick={() => setActiveTab('chat')}
                  className={`mobile-tab ${activeTab === 'chat' ? 'active' : ''}`}
                >
                  💬 聊天
                </button>
                <button
                  onClick={() => setActiveTab('control')}
                  className={`mobile-tab ${activeTab === 'control' ? 'active' : ''}`}
                >
                  ⚡ 控制
                </button>
              </div>
            )}
            {agentOpen && !peerRoom.isDm && peerRoom.canManageGroup && (
              <RoomAgentDialog
                agent={peerRoom.agent}
                agents={peerRoom.agents}
                onSaveAgents={peerRoom.setAgents}
                billingMode={peerRoom.agentBillingMode}
                onBillingModeChange={peerRoom.setRoomAgentBillingMode}
                onSave={peerRoom.setAgent}
                onClose={() => setAgentOpen(false)}
              />
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden ">
              <div className={`${activeTab !== 'chat' ? 'hidden' : 'flex'} min-h-0 flex-col`}>
                <ChatPanel
                  key={peerRoom.roomId}
                  conversationId={peerRoom.roomId}
                  messages={peerRoom.messages}
                  privateMediaToken={peerRoom.isDm ? peerRoom.mediaUploadToken : undefined}
                  onMessageVisible={
                    activeTab === 'chat'
                      ? peerRoom.isDm
                        ? onDmMessageVisible
                        : onGroupMessageVisible
                      : undefined
                  }
                  hasOlderHistory={peerRoom.hasOlderHistory}
                  historyLoading={peerRoom.historyLoading}
                  onLoadOlderHistory={peerRoom.loadOlderHistory}
                  onSend={(text, mentions, replyTo) =>
                    peerRoom.sendMessage(text, undefined, mentions, replyTo)
                  }
                  onRetryMessage={peerRoom.retryMessage}
                  onDiscardMessage={peerRoom.discardMessage}
                  onRecallMessage={peerRoom.recallMessage}
                  jumpToMessageId={jumpToMessageId}
                  onJumpSettled={() => setJumpToMessageId(null)}
                  onSendMedia={sendMedia}
                  members={[
                    { peerId: peerRoom.selfId, name: displayName, username },
                    ...peerRoom.peers.map((peerId) => ({
                      peerId,
                      name: peerRoom.members.get(peerId)?.displayName || peerId.slice(0, 6),
                      username: peerRoom.members.get(peerId)?.username ?? null,
                    })),
                    ...[...peerRoom.members.values()]
                      .filter((member) => member.isAi)
                      .map((member) => ({ peerId: member.peerId, name: member.displayName })),
                  ]}
                  selfId={peerRoom.selfId}
                />
              </div>
              <div
                className={`${activeTab !== 'control' ? 'hidden' : 'flex'} min-h-0 flex-col border-l border-[var(--surface-border)]`}
              >
                <p className="px-4 pt-3 text-[13px] font-medium text-[var(--text-faint)]">
                  {roomPresenceLabel(peerRoom.isDm, peerRoom.peers.length)}
                </p>
                <div className="flex flex-col py-1">
                  <button
                    type="button"
                    className={SETTINGS_ROW}
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="h-5 w-5 shrink-0 text-[var(--text-soft)]" />
                    <span className="flex-1">搜索聊天记录</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
                  </button>
                  {inShell && !peerRoom.isDm && peerRoom.canManageGroup && (
                    <button
                      type="button"
                      onClick={() => setAgentOpen(true)}
                      className={SETTINGS_ROW}
                      title={peerRoom.agent ? `群 AI：${peerRoom.agent.name}` : '给群加个 AI'}
                    >
                      <Bot className="h-5 w-5 shrink-0 text-[var(--text-soft)]" />
                      <span className="flex-1">群 AI</span>
                      {peerRoom.agent && (
                        <span className="truncate text-sm text-[var(--text-faint)]">
                          {peerRoom.agent.name}
                        </span>
                      )}
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
                    </button>
                  )}
                  {!peerRoom.isDm && peerRoom.isOwner && (
                    <button
                      type="button"
                      className={SETTINGS_ROW}
                      onClick={() => {
                        peerRoom.manageGroupMembership('list');
                        setMembersOpen(true);
                      }}
                    >
                      <Users className="h-5 w-5 shrink-0 text-[var(--text-soft)]" />
                      <span className="flex-1">群成员</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
                    </button>
                  )}
                  {inShell && (
                    <button
                      type="button"
                      onClick={leaveRoom}
                      className={`${SETTINGS_ROW} text-[var(--danger)]`}
                    >
                      <LogOut className="h-5 w-5 shrink-0" />
                      <span className="flex-1">{peerRoom.isDm ? '关闭私聊' : '退出群聊'}</span>
                    </button>
                  )}
                </div>
                {inShell &&
                  signedIn &&
                  openMemorySettings &&
                  (peerRoom.isDm ? !!dmPeer?.id : !!peerRoom.roomId) && (
                    <button
                      type="button"
                      className="border-b border-[var(--surface-border)] p-3 text-left text-sm text-[var(--accent)]"
                      onClick={() =>
                        openMemorySettings(
                          peerRoom.isDm ? 'dm' : 'group',
                          peerRoom.isDm ? dmPeer!.id : peerRoom.roomId!,
                        )
                      }
                    >
                      记忆共享
                    </button>
                  )}
                {/* Two separate gates in one group: the first admits any command from this
                    conversation (humans and AI); the second additionally admits room-AI commands
                    and is a browser-wide preference, so it is not per conversation. */}
                <div
                  role="group"
                  aria-label="设备授权"
                  className="space-y-2 border-b border-[var(--surface-border)] p-3 text-sm"
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={conversationDeviceEnabled}
                      onChange={(event) => onSetConversationDeviceEnabled(event.target.checked)}
                    />
                    <span>
                      允许此聊天控制我的设备
                      <span className="block text-xs text-[var(--text-faint)]">
                        仅本账户与本浏览器；仍受安全上限限制，关闭即停止输出。
                      </span>
                    </span>
                  </label>
                  {!peerRoom.isDm && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={allowAi}
                        disabled={!conversationDeviceEnabled}
                        onChange={(event) => setAllowAi(event.target.checked)}
                      />
                      <span className={conversationDeviceEnabled ? '' : 'text-[var(--text-faint)]'}>
                        也允许群 AI 控制（所有群）
                      </span>
                    </label>
                  )}
                </div>
                <ControlPanel
                  key={peerRoom.roomId ?? 'no-room'}
                  members={peerRoom.members}
                  peers={peerRoom.peers}
                  onSendCommand={sendCommand}
                  onSendWaveform={peerRoom.sendWaveform}
                  roomId={peerRoom.roomId}
                  waveforms={waveforms.allWaveforms}
                  onImportWaveform={waveforms.importFile}
                  onImportMarketWaveform={waveforms.addMarketWaveform}
                  onRemoveWaveform={waveforms.removeWaveform}
                  selfState={
                    {
                      peerId: 'self',
                      displayName,
                      username,
                      deviceConnected: device.connected,
                      strengthA: device.strengthA,
                      strengthB: device.strengthB,
                      waveA: device.waveIdA,
                      waveB: device.waveIdB,
                      battery: device.battery,
                      queueA,
                      queueB,
                      playModeA,
                      playModeB,
                      intervalA: intervalASec,
                      intervalB: intervalBSec,
                      currentIndexA,
                      currentIndexB,
                      firingA,
                      firingB,
                      opossumConnected: device.opossum?.connected ?? false,
                      opossumIntensityA: device.opossum?.intensityA ?? 0,
                      opossumIntensityB: device.opossum?.intensityB ?? 0,
                      opossumBattery: device.opossum?.battery ?? null,
                      opossumLastButtons: device.opossum?.lastButtons ?? null,
                      sensorKind: device.sensor?.kind,
                      sensorConnected: device.sensor?.connected ?? false,
                      sensorBattery: device.sensor?.battery ?? null,
                      sensorLastEvent: device.sensor?.lastEvent ?? null,
                      sensorLastValue: device.sensor?.lastValue ?? null,
                      sensorLastEventAt: device.sensor?.lastEventAt ?? null,
                    } satisfies MemberState
                  }
                  selfLimitA={device.limitA}
                  selfLimitB={device.limitB}
                  isPublic={peerRoom.isPublic}
                  canManage={peerRoom.canManageGroup}
                  onSetPublic={peerRoom.setGroupPublic}
                  roomName={peerRoom.groupName}
                  onRename={peerRoom.renameGroup}
                  onCloseRoom={peerRoom.closeGroup}
                  isDm={peerRoom.isDm}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
