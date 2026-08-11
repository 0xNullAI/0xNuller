import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Users } from 'lucide-react';
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
  onDelete: (code: string) => void;
}

export function ShellRoomList({ currentRoom, onJoin, onCreate, onDelete }: ShellRoomListProps) {
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [status, setStatus] = useState<LobbyStatus>('connecting');
  const [listRevision, setListRevision] = useState(0);

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

  // Read on every render rather than once: a group is recorded the moment you join it, and
  // the sidebar is where you go back to it.
  const knownGroups = loadKnownGroups();
  const knownCodes = new Set(knownGroups.map((group) => group.code));
  const merged = new Map<string, LobbyRoom>();
  for (const g of knownGroups) merged.set(g.code, { code: g.code, name: g.name, count: 0 });
  for (const r of rooms) merged.set(r.code, r);

  const ordered: LobbyRoom[] = [...merged.values()];
  void listRevision;

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onCreate}
        className="flex min-h-9 items-center gap-2 rounded-[var(--radius-ctl)] px-2 text-left text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
      >
        <Plus className="h-4 w-4 shrink-0" />
        新建 / 加入房间
      </button>

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
            onClick={() => onJoin(room.code)}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          >
            <span className="min-w-0 flex-1 truncate">{room.name || room.code}</span>
            {room.count > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-[var(--text-faint)]">
                <Users className="h-3 w-3" />
                {room.count}
              </span>
            )}
          </button>
          {knownCodes.has(room.code) ? (
            <button
              type="button"
              aria-label={`删除房间 ${room.name || room.code}`}
              title="从列表删除"
              onClick={() => {
                forgetGroup(room.code);
                setListRevision((value) => value + 1);
                onDelete(room.code);
              }}
              className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-ctl)] text-[var(--text-faint)] opacity-0 hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
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
