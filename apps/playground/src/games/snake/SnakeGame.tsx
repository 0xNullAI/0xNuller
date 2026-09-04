import { useCallback, useEffect } from 'react';
import { useModuleActive } from '@0xnullai/ui';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { BOARD, useSnake, type SnakeEvent } from './use-snake';
import { useGameDevice } from '../../use-game-device';

/**
 * Snake.
 *
 * The board is a CSS grid rather than a canvas: at 17×17 the cell count is
 * trivial, and a grid keeps the cells in the normal layout and theme system
 * instead of needing their own colour handling.
 */
export default function SnakeGame() {
  const { pulse, connected } = useGameDevice();

  const onEvent = useCallback(
    (event: SnakeEvent) => {
      if (event.type === 'ate') pulse('light');
      else pulse('strong');
    },
    [pulse],
  );

  const active = useModuleActive();
  const { state, start, turn } = useSnake({ onEvent, active });

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (
        e.defaultPrevented ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        target?.closest('input,textarea,select,[contenteditable], [role=dialog]') ||
        [...document.querySelectorAll('[role=dialog],#shl-drawer')].some(
          (el) => el.getClientRects().length > 0,
        )
      )
        return;
      const map: Record<string, Parameters<typeof turn>[0]> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
        w: 'up',
        s: 'down',
        a: 'left',
        d: 'right',
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      turn(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, active]);

  const headKey = `${state.snake[0]?.x},${state.snake[0]?.y}`;
  const bodyKeys = new Set(state.snake.slice(1).map((p) => `${p.x},${p.y}`));

  return (
    <div className="flex min-h-full flex-col items-center gap-3 p-3 sm:gap-4 sm:p-4">
      <div className="flex w-full max-w-[420px] items-center justify-between">
        <span className="text-sm text-[var(--text-soft)]">得分 {state.score}</span>
        <span className="text-xs text-[var(--text-faint)]">
          {connected ? '设备已连接' : '未连接设备，纯游戏模式'}
        </span>
      </div>

      <div
        className="grid w-full max-w-[420px] gap-px rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-border)] p-px"
        style={{ gridTemplateColumns: `repeat(${BOARD}, 1fr)`, aspectRatio: '1 / 1' }}
        role="grid"
        aria-label="贪吃蛇棋盘"
      >
        {Array.from({ length: BOARD * BOARD }, (_, i) => {
          const x = i % BOARD;
          const y = Math.floor(i / BOARD);
          const key = `${x},${y}`;
          const isHead = key === headKey;
          const isBody = bodyKeys.has(key);
          const isFood = state.food.x === x && state.food.y === y;
          return (
            <div
              key={key}
              className={
                isHead
                  ? 'bg-[var(--accent)]'
                  : isBody
                    ? 'bg-[var(--accent-strong)]'
                    : isFood
                      ? 'bg-[var(--danger-button)]'
                      : 'bg-[var(--bg-strong)]'
              }
            />
          );
        })}
      </div>

      {state.status !== 'running' && (
        <button
          type="button"
          onClick={start}
          className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-text)]"
        >
          {state.status === 'over' ? `再来一局（上次 ${state.score} 分）` : '开始'}
        </button>
      )}

      {/* Keep the D-pad available at every viewport width. Android can be
          wider than the `sm` breakpoint in landscape, while still having no
          hardware keyboard. */}
      <div className="grid select-none grid-cols-3 gap-2" aria-label="方向控制">
        <span />
        <DirectionButton label="上" onPress={() => turn('up')}>
          <ArrowUp aria-hidden="true" className="h-6 w-6" />
        </DirectionButton>
        <span />
        <DirectionButton label="左" onPress={() => turn('left')}>
          <ArrowLeft aria-hidden="true" className="h-6 w-6" />
        </DirectionButton>
        <DirectionButton label="下" onPress={() => turn('down')}>
          <ArrowDown aria-hidden="true" className="h-6 w-6" />
        </DirectionButton>
        <DirectionButton label="右" onPress={() => turn('right')}>
          <ArrowRight aria-hidden="true" className="h-6 w-6" />
        </DirectionButton>
      </div>

      <p className="text-center text-xs text-[var(--text-faint)]">
        点按方向键即可开始；电脑也可使用键盘方向键或 WASD
      </p>
    </div>
  );
}

function DirectionButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`向${label}`}
      className="flex h-13 w-13 touch-manipulation items-center justify-center rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text)] shadow-sm transition-colors active:bg-[var(--accent-soft)] active:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      {children}
    </button>
  );
}
