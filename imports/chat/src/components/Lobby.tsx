import { useEffect, useState } from 'react';
import { Users, ArrowLeft, RefreshCw, DoorOpen, Drama } from 'lucide-react';
import { subscribeLobby, fetchLobbyRooms, type LobbyRoom, type LobbyStatus } from '../lib/lobby-client';

/** 房间大厅：列出房主主动公开的房间，点击即跳主页加入。私密房间不会出现在这里。 */
export function Lobby() {
  const [rooms, setRooms] = useState<LobbyRoom[]>([]);
  const [status, setStatus] = useState<LobbyStatus>('connecting');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // 先用 REST 拿一次快照，再交给 WS 实时更新。
    fetchLobbyRooms().then(r => {
      setRooms(r);
      setLoaded(true);
    });
    const sub = subscribeLobby(
      r => {
        setRooms(r);
        setLoaded(true);
      },
      setStatus,
    );
    return () => sub.close();
  }, []);

  function joinRoom(code: string) {
    window.location.assign(`/?room=${encodeURIComponent(code)}`);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)]">
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3">
        <a
          href="/"
          className="flex items-center gap-1.5 text-sm text-[var(--text-soft)] transition-colors hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-4 w-4" /> 返回
        </a>
        <h1 className="text-base font-bold text-[var(--text)]">房间大厅</h1>
        <span
          className={`flex items-center gap-1 text-[11px] ${
            status === 'connected' ? 'text-[var(--success)]' : 'text-[var(--text-faint)]'
          }`}
        >
          <RefreshCw className={`h-3 w-3 ${status === 'connecting' ? 'animate-spin' : ''}`} />
          {status === 'connected' ? '实时' : '连接中'}
        </span>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-4">
        {!loaded ? (
          <div className="mt-20 text-center text-sm text-[var(--text-faint)]">加载中...</div>
        ) : rooms.length === 0 ? (
          <div className="mt-20 flex flex-col items-center gap-2 text-[var(--text-faint)]">
            <DoorOpen className="h-10 w-10" />
            <p className="text-sm">当前没有公开房间</p>
            <p className="text-xs">回到首页创建一个并勾选「公开到大厅」吧</p>
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map(room => (
              <li key={room.code}>
                <button
                  onClick={() => joinRoom(room.code)}
                  className="flex w-full items-center justify-between rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-4 py-3 text-left transition-colors hover:border-[var(--accent)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text)]">
                      {room.name || room.code}
                    </p>
                    {room.sceneName && (
                      <span className="mt-1 flex w-fit max-w-full items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] text-[var(--accent)]">
                        <Drama className="h-3 w-3 shrink-0" />
                        <span className="truncate">{room.sceneName}</span>
                      </span>
                    )}
                    <p className="mt-0.5 truncate text-[11px] tabular-nums text-[var(--text-faint)]">
                      #{room.code}
                    </p>
                  </div>
                  <span className="ml-3 flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">
                    <Users className="h-3.5 w-3.5" />
                    {room.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="shrink-0 py-3 text-center text-[10px] text-[var(--text-faint)]">
        仅显示房主主动公开的房间。私密房间需房间号才能加入。
      </footer>
    </div>
  );
}
