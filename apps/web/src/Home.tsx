import { useEffect, useState } from 'react';
import { MODULES } from './routes';

const VISITED_KEY = '0xnullai-visited';

const HOME_GROUPS = [
  {
    id: 'control',
    title: '控制与协作',
    description: '从手动控制开始，或交给对话、语音和视觉协助。',
    modules: ['control', 'agent', 'voice', 'video'],
  },
  {
    id: 'connect',
    title: '连接与探索',
    description: '进入多人互动，发现社区内容，或把设备接入游戏。',
    modules: ['chat', 'market', 'playground'],
  },
] as const;

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
      <div className="shl-home-layout">
        <header className="shl-home-header">
          <div className="shl-home-identity">
            <div className="flex items-center gap-3">
              <span className="shl-home-mark" aria-hidden>
                <svg viewBox="0 0 40 20" className="h-5 w-8">
                  <path
                    d="M2 10h6l3-7 6 14 6-14 4 7h11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <p className="shl-home-eyebrow">统一设备工作台</p>
                <h1 className="shl-home-title" style={{ fontFamily: 'var(--font-display)' }}>
                  {returning ? (
                    <>
                      <span className="text-[var(--accent-strong)]">欢迎</span>回来
                    </>
                  ) : (
                    <span className="text-[var(--accent-strong)]">0xNuller</span>
                  )}
                </h1>
              </div>
            </div>
            <p className="shl-home-intro">
              {returning
                ? '继续使用共用设备、安全设置和波形库。'
                : '一次连接，所有模块共用设备、安全设置和波形库。'}
            </p>
          </div>
          <p className="shl-home-summary" aria-label="可用模块数量">
            <strong>{MODULES.length}</strong>
            <span>个模块</span>
          </p>
        </header>

        <nav className="shl-home-nav" aria-label="功能模块">
          {HOME_GROUPS.map((group) => (
            <section
              key={group.id}
              className="shl-home-group"
              aria-labelledby={`${group.id}-title`}
            >
              <div className="shl-home-group-heading">
                <h2 id={`${group.id}-title`}>{group.title}</h2>
                <p>{group.description}</p>
              </div>
              <ul className="shl-home-grid">
                {group.modules.map((id, index) => {
                  const module = MODULES.find((candidate) => candidate.id === id);
                  if (!module) return null;
                  return (
                    <li key={module.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(module.id)}
                        className="shl-home-card"
                      >
                        <span className="shl-home-card-index" aria-hidden>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="shl-home-card-copy">
                          <span className="shl-home-card-title">{module.label}</span>
                          <span className="shl-home-card-blurb">{module.blurb}</span>
                        </span>
                        <span className="shl-home-card-arrow" aria-hidden>
                          ↗
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </div>
    </div>
  );
}
