import { useEffect, useId, useState } from 'react';
import { ChevronDown, LogOut, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import {
  fetchLobbyRooms,
  subscribeLobby,
  type LobbyRoom,
  type LobbyStatus,
} from '../lib/lobby-client';
import { forgetGroup, GROUPS_CHANGED_EVENT, loadKnownGroups, syncKnownGroups } from '../lib/groups';

/**
 * The room list in its **shell sidebar** form.
 *
 * Before the merge, entering Chat meant first meeting a centered card: type a nickname, then
 * create or join a room; the public room list lived on another page (`/lobby`), reached by
 * full-page navigation back and forth. With a unified account there is no need to ask for a
 * nickname any more, and the room list should not require navigating to another page. The sidebar
 * keeps that directory collapsed until requested so a large public lobby cannot crowd out the rest
 * of the navigation.
 *
 * The permanent public room sorts first and is labeled as such: it guarantees there is always
 * somewhere to go, so a new user is never left staring at an empty list with nothing to do.
 *
 * The lobby is not the whole list any more. Rooms are permanent groups, so the ones you belong
 * to have to be reachable when nobody is online in them — and a private group is never in the
 * lobby at all. Those come from the local record instead, and the lobby's copy wins wherever
 * both have the same code (it carries the live name and member count).
 */

export interface ShellRoomListProps {
  currentRoom: string | null;
  onJoin: (code: string) => void;
  onCreate: () => void;
  onDelete: (code: string) => void;
  /** `directory` shows every public room. The sidebar otherwise shows memberships only,
   * falling back to the public directory when this account has not joined anything yet. */
  mode?: 'memberships' | 'directory';
}

export function buildVisibleRooms(
  knownGroups: { code: string; name: string }[],
  publicRooms: LobbyRoom[],
  mode: 'memberships' | 'directory',
): LobbyRoom[] {
  if (mode === 'directory' || knownGroups.length === 0) return publicRooms;
  const live = new Map(publicRooms.map((room) => [room.code, room]));
  return knownGroups.map((group) => live.get(group.code) ?? { ...group, count: 0 });
}

export function ShellRoomList({
  currentRoom,
  onJoin,
  onCreate,
  onDelete,
  mode = 'memberships',
}: ShellRoomListProps) {
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [status, setStatus] = useState<LobbyStatus>('connecting');
  const [listRevision, setListRevision] = useState(0);
  const [pendingRoom, setPendingRoom] = useState<string | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(mode === 'directory');
  const directoryId = useId();

  useEffect(() => {
    // Take one REST snapshot first, then hand over to the WS for live updates — waiting on the
    // WS alone leaves the first paint empty for a beat.
    void fetchLobbyRooms()
      .then(setRooms)
      .catch(() => undefined);
    const sub = subscribeLobby(setRooms, setStatus);
    const changed = () => setListRevision((value) => value + 1);
    window.addEventListener(GROUPS_CHANGED_EVENT, changed);
    void syncKnownGroups();
    return () => {
      sub.close();
      window.removeEventListener(GROUPS_CHANGED_EVENT, changed);
    };
  }, []);

  useEffect(() => {
    if (!pendingRoom) return;
    const timeout = window.setTimeout(() => setPendingRoom(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [pendingRoom]);

  // Read on every render rather than once: a group is recorded the moment you join it, and
  // the sidebar is where you go back to it.
  const knownGroups = loadKnownGroups();
  const knownCodes = new Set(knownGroups.map((group) => group.code));
  const ordered = buildVisibleRooms(knownGroups, rooms, mode);
  const showingDirectory = mode === 'directory' || knownGroups.length === 0;
  const showRooms = !showingDirectory || directoryOpen;
  void listRevision;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onCreate}
        className="flex min-h-11 touch-manipulation items-center gap-2 rounded-[var(--radius-ctl)] px-2 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)] active:bg-[var(--accent-soft)]"
      >
        <Plus className="h-4 w-4 shrink-0" />
        新建 / 加入房间
      </button>

      {showingDirectory && rooms.length > 0 ? (
        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-2">
          <p className="min-w-0 text-[11px] text-[var(--text-faint)]">
            {knownGroups.length === 0 && mode === 'memberships' ? '尚未加入房间' : '公开房间'}
          </p>
          <button
            type="button"
            aria-expanded={directoryOpen}
            aria-controls={directoryId}
            onClick={() => setDirectoryOpen((open) => !open)}
            className="flex shrink-0 items-center gap-1 rounded-[var(--radius-ctl)] px-1.5 py-1 text-[11px] text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
          >
            {directoryOpen ? '隐藏' : '显示'}公开房间（{rooms.length}）
            <ChevronDown
              className={`h-3 w-3 transition-transform ${directoryOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>
      ) : null}

      <div
        id={showingDirectory ? directoryId : undefined}
        hidden={!showRooms}
        className={
          showingDirectory ? 'max-h-64 overflow-y-auto overscroll-contain pr-1' : undefined
        }
      >
        {ordered.map((room) => (
          <div
            key={room.code}
            className={
              'group flex items-center rounded-[var(--radius-ctl)] text-sm transition-colors ' +
              (room.code === currentRoom
                ? 'bg-[var(--accent-soft)]'
                : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
            }
          >
            <button
              type="button"
              disabled={pendingRoom === room.code && currentRoom !== room.code}
              aria-busy={pendingRoom === room.code && currentRoom !== room.code}
              onClick={() => {
                if (room.code === currentRoom) return;
                setPendingRoom(room.code);
                onJoin(room.code);
              }}
              className="flex min-h-11 min-w-0 flex-1 touch-manipulation items-center gap-2 px-2 py-2 text-left active:bg-[var(--accent-soft)] disabled:opacity-70"
            >
              <span className="min-w-0 flex-1 truncate">{room.name || room.code}</span>
              {pendingRoom === room.code && currentRoom !== room.code && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--accent)]">
                  <RefreshCw className="h-3 w-3 animate-spin" /> 进入中
                </span>
              )}
              {room.count > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-[var(--text-faint)]">
                  <Users className="h-3 w-3" />
                  {room.count}
                </span>
              )}
            </button>
            {knownCodes.has(room.code) || room.code === currentRoom ? (
              <button
                type="button"
                aria-label={`${room.code === currentRoom ? '退出' : '删除'}房间 ${room.name || room.code}`}
                title={room.code === currentRoom ? '退出房间' : '从列表删除'}
                onClick={() => {
                  forgetGroup(room.code);
                  setListRevision((value) => value + 1);
                  onDelete(room.code);
                }}
                className="mr-1 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-faint)] opacity-100 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] focus-visible:opacity-100 sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100"
              >
                {room.code === currentRoom ? (
                  <LogOut className="h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {status === 'connecting' && rooms.length === 0 && (
        <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-[var(--text-faint)]">
          <RefreshCw className="h-3 w-3 animate-spin" />
          正在获取房间
        </p>
      )}
    </div>
  );
}
