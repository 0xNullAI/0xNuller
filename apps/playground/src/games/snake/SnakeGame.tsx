import { useCallback, useEffect } from 'react';
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
      // Feedback strength is a *request*. The device holder's safety caps
      // decide what actually lands — a game must never be a way around them.
      if (event.type === 'ate') pulse('light');
      else pulse('strong');
    },
    [pulse],
  );

  const { state, start, turn } = useSnake({ onEvent });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [turn]);

  const headKey = `${state.snake[0]?.x},${state.snake[0]?.y}`;
  const bodyKeys = new Set(state.snake.slice(1).map((p) => `${p.x},${p.y}`));

  return (
    <div className="flex flex-col items-center gap-4 p-4">
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

      {/* Touch controls: the keyboard is not an option on a phone, and this
          module ships inside the Android app. */}
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        <span />
        <TouchButton label="上" onPress={() => turn('up')} />
        <span />
        <TouchButton label="左" onPress={() => turn('left')} />
        <TouchButton label="下" onPress={() => turn('down')} />
        <TouchButton label="右" onPress={() => turn('right')} />
      </div>

      <p className="max-w-[420px] text-center text-xs text-[var(--text-faint)]">
        方向键或 WASD 控制。吃到食物会给一次短反馈，撞墙或咬到自己会给一次稍强的——强度始终受你的设备安全上限约束。
      </p>
    </div>
  );
}

function TouchButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="h-12 w-12 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] text-sm text-[var(--text-soft)]"
    >
      {label}
    </button>
  );
}
