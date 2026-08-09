import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Users } from 'lucide-react';
import {
  fetchLobbyRooms,
  subscribeLobby,
  type LobbyRoom,
  type LobbyStatus,
} from '../lib/lobby-client';
import { RESERVED_ROOM_CODE } from '../../shared/room-constants';
import { loadKnownGroups } from '../lib/groups';

/**
 * The room list in its **shell sidebar** form.
 *
 * Before the merge, entering Chat meant first meeting a centered card: type a nickname, then
 * create or join a room; the public room list lived on another page (`/lobby`), reached by
 * full-page navigation back and forth. With a unified account there is no need to ask for a
 * nickname any more, and the room list should not be hidden on another page either — you should
 * see which rooms exist the moment you open it.
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
}

export function ShellRoomList({ currentRoom, onJoin, onCreate }: ShellRoomListProps) {
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [status, setStatus] = useState<LobbyStatus>('connecting');

  useEffect(() => {
    // Take one REST snapshot first, then hand over to the WS for live updates — waiting on the
    // WS alone leaves the first paint empty for a beat.
    void fetchLobbyRooms()
      .then(setRooms)
      .catch(() => undefined);
    const sub = subscribeLobby(setRooms, setStatus);
    return () => sub.close();
  }, []);

  // Read on every render rather than once: a group is recorded the moment you join it, and
  // the sidebar is where you go back to it.
  const merged = new Map<string, LobbyRoom>();
  for (const g of loadKnownGroups()) merged.set(g.code, { code: g.code, name: g.name, count: 0 });
  for (const r of rooms) merged.set(r.code, r);

  // The permanent room is always first, and is shown even before the lobby has answered — it is
  // the one that guarantees there is always somewhere to go.
  const reserved = merged.get(RESERVED_ROOM_CODE) ?? {
    code: RESERVED_ROOM_CODE,
    name: '公开大厅',
    count: 0,
  };
  const ordered: LobbyRoom[] = [
    reserved,
    ...[...merged.values()].filter((r) => r.code !== RESERVED_ROOM_CODE),
  ];

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
      >
        <Plus className="h-4 w-4 shrink-0" />
        建房间
      </button>

      {ordered.map((room) => (
        <button
          key={room.code}
          type="button"
          onClick={() => onJoin(room.code)}
          className={
            'flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm transition-colors ' +
            (room.code === currentRoom
              ? 'bg-[var(--accent-soft)]'
              : 'text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]')
          }
        >
          <span className="min-w-0 flex-1 truncate">
            {room.name || room.code}
            {room.code === RESERVED_ROOM_CODE && (
              <span className="ml-1.5 text-[10px] text-[var(--text-faint)]">常驻</span>
            )}
          </span>
          {room.count > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-[var(--text-faint)]">
              <Users className="h-3 w-3" />
              {room.count}
            </span>
          )}
        </button>
      ))}

      {status === 'connecting' && rooms.length === 0 && (
        <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-[var(--text-faint)]">
          <RefreshCw className="h-3 w-3 animate-spin" />
          正在获取房间
        </p>
      )}
    </div>
  );
}
