import { SidebarSection } from '@0xnullai/ui';
import { Bot, LogOut, Settings2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { DmRequest } from '@0xnullai/auth';
import type { useDevice } from '../hooks/use-device';
import type { usePeerRoom } from '../hooks/use-peer-room';
import type { useWaveforms } from '../hooks/use-waveforms';
import type { CmdAction, DeviceCommand, MemberState, PlayMode } from '../lib/protocol';
import { ChatPanel } from './ChatPanel';
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
  if (peerCount === 0) return isDm ? '对方不在线' : '等待成员';
  return isDm ? '对方在线' : `${peerCount + 1} 人在线`;
}

export function leaveChatRoom(
  disconnect: () => void,
  leave: () => void,
  clearDmPeer: () => void,
): void {
  // Preserve the safety-sensitive ordering: disconnect output before leaving the transport,
  // then clear the local DM header only after both lifecycle operations were requested.
  disconnect();
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
  activeTab: 'chat' | 'control';
  setActiveTab: Dispatch<SetStateAction<'chat' | 'control'>>;
  agentOpen: boolean;
  setAgentOpen: Dispatch<SetStateAction<boolean>>;
  inShell: boolean;
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
  sendMedia: (
    blob: Blob,
    kind: 'image' | 'audio',
    meta?: { durationMs?: number; w?: number; h?: number },
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
  activeTab,
  setActiveTab,
  agentOpen,
  setAgentOpen,
  inShell,
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
  sendMedia,
  sendCommand,
}: ChatAppViewProps) {
  const roomTitle = peerRoom.isDm ? (dmPeer?.name ?? '私聊') : peerRoom.groupName || '房间';
  const leaveRoom = () => {
    leaveChatRoom(device.disconnect, peerRoom.leave, () => setDmPeer(null));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {signedIn && (
        <SidebarSection id="direct" title="私聊">
          <ShellDmList
            currentRoom={peerRoom.isDm ? peerRoom.roomId : null}
            onOpen={(peer) => {
              showChat();
              void openDm({
                accountId: peer.id,
                username: peer.username,
                displayName: peer.displayName,
              });
            }}
          />
        </SidebarSection>
      )}

      <SidebarSection id="rooms" title="房间">
        <ShellRoomList
          currentRoom={peerRoom.isDm ? null : peerRoom.roomId}
          onJoin={(code) => {
            if (!requireAccount()) return;
            showChat();
            setDmPeer(null);
            peerRoom.join(code);
          }}
          onCreate={() => {
            if (!requireAccount()) return;
            showChat();
            setCreateRoomOpen(true);
          }}
          onDelete={(code) => {
            if (peerRoom.roomId === code) peerRoom.leave();
          }}
        />
      </SidebarSection>

      {accountRequired && !signedIn ? (
        <div
          role="alert"
          className="mx-3 mb-2 rounded-[var(--radius-sm)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--text-soft)]"
        >
          登录后才能创建、加入房间或发起私聊；公开房间仍可浏览。
        </div>
      ) : null}

      {createRoomOpen && (
        <CreateRoomDialog
          defaultName={displayName}
          onCreate={(code, options) => peerRoom.join(code, { ...options, claim: true })}
          onJoin={(code) => peerRoom.join(code)}
          onClose={() => setCreateRoomOpen(false)}
        />
      )}

      <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--text)]">
            {roomTitle}
          </span>
          {dmError && (
            <span className="shrink-0 rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-xs text-[var(--danger)]">
              {dmError}
            </span>
          )}
          <span
            className={
              peerRoom.peers.length > 0
                ? 'rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]'
                : 'rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-xs text-[var(--text-faint)]'
            }
          >
            {roomPresenceLabel(peerRoom.isDm, peerRoom.peers.length)}
          </span>
        </div>
        {!inShell && (
          <div className="flex shrink-0 items-center gap-1">
            {!peerRoom.isDm && (
              <>
                {peerRoom.canManageGroup && (
                  <button
                    onClick={() => setAgentOpen(true)}
                    className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] transition-colors hover:bg-[var(--bg-soft)] ${peerRoom.agent ? 'text-[var(--accent)]' : 'text-[var(--text-soft)]'}`}
                    title={peerRoom.agent ? `房间 AI：${peerRoom.agent.name}` : '给房间加个 AI'}
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
                {device.connected && (
                  <button
                    onClick={() => setAllowAi((value) => !value)}
                    className={`flex h-9 items-center gap-1 rounded-[var(--radius-ctl)] px-2 text-[11px] transition-colors hover:bg-[var(--bg-soft)] ${allowAi ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}
                    title={allowAi ? 'AI 可控制你的设备，点击关闭' : '允许房间内 AI 控制你的设备'}
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {allowAi ? '允许AI' : '禁AI'}
                  </button>
                )}
              </>
            )}
            <DeviceSafetyButton
              connected={device.connected}
              deviceName={device.deviceInfo?.name ?? null}
              battery={device.battery}
              onDisconnect={() => device.disconnectCoyote()}
              limitA={device.limitA}
              limitB={device.limitB}
              onSetLimit={device.setLimit}
              firePolicy={device.firePolicy}
              onSetFirePolicy={device.setFirePolicy}
              onRestoreDefaults={waveforms.restoreDefaults}
              sensor={device.sensor}
              opossum={device.opossum}
              onConnectDevice={device.connectDevice}
              onDisconnectSensor={device.disconnectSensor}
              onDisconnectOpossum={device.disconnectOpossum}
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
              title={peerRoom.isDm ? '关闭私聊' : '离开房间'}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
        {inShell && peerRoom.roomId && (
          <button
            onClick={leaveRoom}
            className="flex h-9 shrink-0 items-center gap-1 rounded-[var(--radius-ctl)] px-2 text-xs text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--danger)]"
            title={peerRoom.isDm ? '关闭私聊' : '离开房间'}
          >
            <LogOut className="h-4 w-4" />
            <span>{peerRoom.isDm ? '关闭' : '退出'}</span>
          </button>
        )}
      </header>

      {!peerRoom.roomId ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="mx-auto w-full max-w-2xl rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 sm:p-6">
            <h2 className="text-lg font-semibold">公开房间</h2>
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
          <div className="flex shrink-0 border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] lg:hidden">
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
          {!inShell && agentOpen && (
            <RoomAgentDialog
              agent={peerRoom.agent}
              onSave={peerRoom.setAgent}
              onClose={() => setAgentOpen(false)}
            />
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-2">
            <div className={`${activeTab !== 'chat' ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col`}>
              <ChatPanel
                messages={peerRoom.messages}
                onSend={(text, mentions) => peerRoom.sendMessage(text, undefined, mentions)}
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
              className={`${activeTab !== 'control' ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col border-l border-[var(--surface-border)]`}
            >
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
  );
}
