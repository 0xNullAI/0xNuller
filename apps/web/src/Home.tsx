import { useEffect, useState } from 'react';
import { MODULES } from './routes';

const VISITED_KEY = '0xnullai-visited';

/**
 * The root path. It has two modes, a first-visit introduction and a
 * returning-visitor grid — anonymous use is a hard constraint, so having
 * navigation must never become a reward for signing in.
 *
 * Which mode applies is captured once, when the component mounts, rather than
 * read on every render. Reading it live meant the flag had already been
 * written by the time anything re-rendered, so a first-time visitor lost the
 * introduction the moment any parent state changed — mid-visit, with no way
 * to get it back.
 */
export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [returning] = useState(() => {
    try {
      return localStorage.getItem(VISITED_KEY) === '1';
    } catch {
      return false; // private mode / storage disabled: treat as a first visit
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(VISITED_KEY, '1');
    } catch {
      /* nothing here depends on the write succeeding */
    }
  }, []);

  return (
    <div className="shl-home h-full overflow-y-auto">
      {/* Centred vertically while the content is shorter than the viewport,
          top-aligned and scrolling once it is not. Six cards leave a lot of
          room at 1440px, and letting them sit against the top edge reads as
          a page that failed to finish loading. */}
      <div className="flex min-h-full flex-col justify-center">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-5 py-12 sm:py-16">
          <header className="flex flex-col gap-3">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {returning ? '欢迎回来' : '0xNuller'}
            </h1>
            {!returning ? (
              <p className="max-w-[52ch] text-[var(--text-soft)]">
                六个模块共用一套设备协议、一套安全链和一份波形库。连一次设备，处处可用。
              </p>
            ) : null}
          </header>

          <div className="grid gap-3 sm:grid-cols-2">
            {MODULES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-5 py-4 text-left transition-colors duration-[var(--dur)] hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="font-medium">{m.label}</span>
                <span className="text-sm text-[var(--text-soft)]">{m.blurb}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
