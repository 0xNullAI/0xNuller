import { MODULES } from './routes';

/**
 * The root path. Local state splits it into two modes, a first-visit introduction
 * and a returning-visitor navigation — anonymous use is a hard constraint, so
 * having navigation must never become a reward for signing in.
 */
export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const returning = localStorage.getItem('0xnullai-visited') === '1';
  localStorage.setItem('0xnullai-visited', '1');

  return (
    <div className="shl-home h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10 px-5 py-12 sm:py-16">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {returning ? '欢迎回来' : '0xNuller'}
          </h1>
          {!returning ? (
            <p className="max-w-[52ch] text-[var(--text-soft)]">
              四个模块共用一套设备协议、一套安全链和一份波形库。连一次设备，四处可用。
            </p>
          ) : null}
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpen(m.id)}
              className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-5 py-4 text-left transition-colors hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="font-medium">{m.label}</span>
              <span className="text-sm text-[var(--text-soft)]">{m.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
