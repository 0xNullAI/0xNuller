import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Users } from 'lucide-react';
import {
  fetchLobbyRooms,
  subscribeLobby,
  type LobbyRoom,
  type LobbyStatus,
} from '../lib/lobby-client';
import { RESERVED_ROOM_CODE } from '../../shared/room-constants';

/**
 * 房间列表在**外壳侧边栏**里的形态。
 *
 * 合并前进 Chat 要先看到一张居中的卡片：填昵称、然后创建或加入房间；公开房间列表
 * 在另一个页面（`/lobby`），靠整页跳转往返。有了统一账号之后昵称不必再问，房间列表
 * 也不该藏在另一个页面——打开就该看到有哪些房间在。
 *
 * 常驻公开房排在最前并标出来：它保证任何时候都有一个可进的地方，新用户不会面对
 * 一个空列表不知道该干什么。
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
    // 先用 REST 拿一次快照再交给 WS 实时更新——只等 WS 的话首屏会空一拍。
    void fetchLobbyRooms()
      .then(setRooms)
      .catch(() => undefined);
    const sub = subscribeLobby(setRooms, setStatus);
    return () => sub.close();
  }, []);

  // 常驻房永远排第一，且即使大厅还没返回也先显示——它是保证「总有地方可去」的那一个。
  const hasReserved = rooms.some((r) => r.code === RESERVED_ROOM_CODE);
  const ordered = [
    ...(hasReserved ? [] : [{ code: RESERVED_ROOM_CODE, name: '公开大厅', count: 0 } as LobbyRoom]),
    ...rooms
      .slice()
      .sort((a, b) => (a.code === RESERVED_ROOM_CODE ? -1 : b.code === RESERVED_ROOM_CODE ? 1 : 0)),
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
