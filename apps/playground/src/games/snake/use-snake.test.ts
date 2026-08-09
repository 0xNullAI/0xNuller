import { describe, expect, it } from 'vitest';
import { BOARD, advance, type SnakeState } from './use-snake';

/**
 * The rules are a pure function so they can be pinned without a canvas or a
 * device. The collision cases matter most: in Playground a game-over fires a
 * device pulse, so a wrong collision means a pulse the player did not earn.
 */

const base = (over: Partial<SnakeState> = {}): SnakeState => ({
  snake: [{ x: 5, y: 5 }],
  food: { x: 0, y: 0 },
  direction: 'right',
  status: 'running',
  score: 0,
  ...over,
});

const fixedRandom = () => 0;

describe('贪吃蛇规则', () => {
  it('按方向前进一格', () => {
    const { next } = advance(base(), fixedRandom);
    expect(next.snake[0]).toEqual({ x: 6, y: 5 });
  });

  it('吃到食物会变长、加分，并抛出事件', () => {
    const { next, event } = advance(base({ food: { x: 6, y: 5 } }), fixedRandom);

    expect(next.snake).toHaveLength(2);
    expect(next.score).toBe(1);
    expect(event).toEqual({ type: 'ate', length: 2 });
  });

  it('没吃到就不变长', () => {
    const { next } = advance(base({ snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }] }), fixedRandom);
    expect(next.snake).toHaveLength(2);
  });

  it('撞墙结束', () => {
    const { next, event } = advance(
      base({ snake: [{ x: BOARD - 1, y: 5 }], direction: 'right' }),
      fixedRandom,
    );

    expect(next.status).toBe('over');
    expect(event).toEqual({ type: 'over', score: 0 });
  });

  it('咬到自己结束', () => {
    const snake = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 },
      { x: 7, y: 5 },
    ];
    const { next } = advance(base({ snake, direction: 'right' }), fixedRandom);
    expect(next.status).toBe('over');
  });

  it('刚空出来的尾格可以走进去，不算撞', () => {
    // The tail moves out of the way on the same tick, so this is legal.
    const snake = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 6 },
      { x: 5, y: 6 },
    ];
    const { next } = advance(base({ snake, direction: 'down' }), fixedRandom);
    expect(next.status).toBe('running');
  });

  it('结束之后不再推进', () => {
    const state = base({ status: 'over' });
    const { next, event } = advance(state, fixedRandom);
    expect(next).toBe(state);
    expect(event).toBeUndefined();
  });

  it('食物不会长在蛇身上', () => {
    const snake = [
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ];
    const { next } = advance(
      base({ snake: [{ x: 0, y: 0 }], food: { x: 1, y: 0 }, direction: 'right' }),
      fixedRandom,
    );
    expect(next.snake.some((p) => p.x === next.food.x && p.y === next.food.y)).toBe(false);
    expect(snake).toBeDefined();
  });
});
