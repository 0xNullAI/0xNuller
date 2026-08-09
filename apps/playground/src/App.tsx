import { Suspense, useState } from 'react';
import { ArrowLeft, Gamepad2 } from 'lucide-react';
import { GAMES } from './games';

/**
 * Playground: the games module.
 *
 * A list, and one game at a time. Games that are not built yet are listed
 * with their real status instead of being hidden, so the module says what it
 * is going to be rather than looking finished.
 */
export default function App() {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = GAMES.find((g) => g.id === openId && g.status === 'ready');

  if (open?.Component) {
    const Game = open.Component;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--surface-border)] px-3 py-2">
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className="flex items-center gap-1.5 rounded-[var(--radius-ctl)] px-2 py-1 text-sm text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)]"
          >
            <ArrowLeft className="h-4 w-4" />
            全部游戏
          </button>
          <span className="text-sm font-medium">{open.name}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Suspense fallback={<p className="p-6 text-sm text-[var(--text-faint)]">加载中…</p>}>
            <Game />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-5 py-8">
        <header className="flex flex-col gap-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Gamepad2 className="h-6 w-6 text-[var(--accent)]" />
            Playground
          </h1>
          <p className="max-w-[52ch] text-sm text-[var(--text-soft)]">
            把设备接进游戏。游戏只能请求一次反馈，实际强度由你的设备安全上限决定。
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {GAMES.map((game) => {
            const ready = game.status === 'ready';
            return (
              <button
                key={game.id}
                type="button"
                disabled={!ready}
                onClick={() => setOpenId(game.id)}
                className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-4 py-3 text-left transition-colors enabled:hover:border-[var(--accent)] disabled:opacity-55"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{game.name}</span>
                  {!ready && (
                    <span className="rounded-full bg-[var(--bg-soft)] px-2 py-0.5 text-[10px] text-[var(--text-faint)]">
                      敬请期待
                    </span>
                  )}
                </span>
                <span className="text-sm text-[var(--text-soft)]">{game.blurb}</span>
                <span className="text-xs text-[var(--text-faint)]">{game.deviceUse}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
