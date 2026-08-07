import { MODULES } from './routes';

/**
 * 根路径。
 *
 * 按访客状态分两态：没打开过任何模块就介绍这是什么，回访直接把入口摆出来。
 * 判断依据是本地状态而不是登录态——匿名可用是硬约束，不能让「有导航」变成
 * 登录的奖励。
 */
export function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const returning = localStorage.getItem('0xnullai-visited') === '1';
  localStorage.setItem('0xnullai-visited', '1');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-5 py-12 sm:py-16">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {returning ? '欢迎回来' : 'DG-Lab 郊狼的统一控制平台'}
          </h1>
          {!returning ? (
            <p className="max-w-[52ch] text-[var(--text-soft)]">
              四个模块共用一套设备协议、一套安全链和一份波形库。连一次设备，四处可用。
            </p>
          ) : null}
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          {MODULES.filter((m) => m.id !== 'wiki').map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpen(m.id)}
              className="flex flex-col gap-1.5 rounded-[16px] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-5 py-4 text-left transition-colors hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="font-medium">{m.label}</span>
              <span className="text-sm text-[var(--text-soft)]">{m.blurb}</span>
            </button>
          ))}
        </div>

        {!returning ? (
          <section className="flex flex-col gap-2 rounded-[16px] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-5 py-4">
            <h2 className="text-sm font-medium">开始之前</h2>
            <p className="text-sm text-[var(--text-soft)]">
              这些模块会控制向身体输出电流的设备。第一次使用请把强度上限调低，确认「停止」在哪里，
              再逐步放开。任何时候都可以一步停下。
            </p>
          </section>
        ) : null}

        <footer className="text-sm text-[var(--text-faint)]">
          <button
            type="button"
            onClick={() => onOpen('wiki')}
            className="underline underline-offset-2 hover:text-[var(--text-soft)]"
          >
            查看文档
          </button>
        </footer>
      </div>
    </div>
  );
}
