import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Snake, as a pure state machine.
 *
 * Kept free of device and rendering concerns so the rules can be tested
 * without a canvas or a Coyote: the game emits events, and whoever mounted it
 * decides what those mean.
 */

export const BOARD = 17;

export type Point = { x: number; y: number };
export type Direction = 'up' | 'down' | 'left' | 'right';
export type SnakeStatus = 'idle' | 'running' | 'over';

/** Things the host may want to react to — a device pulse, a sound, a score. */
export type SnakeEvent = { type: 'ate'; length: number } | { type: 'over'; score: number };

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

const STEP: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** A free cell, chosen from the cells actually free rather than by retrying at random. */
function placeFood(snake: Point[], random: () => number): Point {
  const taken = new Set(snake.map((p) => `${p.x},${p.y}`));
  const free: Point[] = [];
  for (let y = 0; y < BOARD; y++) {
    for (let x = 0; x < BOARD; x++) {
      if (!taken.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return snake[0]!;
  return free[Math.floor(random() * free.length)]!;
}

export interface SnakeState {
  snake: Point[];
  food: Point;
  direction: Direction;
  status: SnakeStatus;
  score: number;
}

function initialState(random: () => number): SnakeState {
  const start: Point[] = [{ x: 8, y: 8 }];
  return {
    snake: start,
    food: placeFood(start, random),
    direction: 'right',
    status: 'idle',
    score: 0,
  };
}

/** One tick. Exported so the rules can be tested directly. */
export function advance(
  state: SnakeState,
  random: () => number,
): { next: SnakeState; event?: SnakeEvent } {
  if (state.status !== 'running') return { next: state };

  const head = state.snake[0]!;
  const step = STEP[state.direction];
  const nextHead = { x: head.x + step.x, y: head.y + step.y };

  const hitWall = nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= BOARD || nextHead.y >= BOARD;
  // The tail cell is about to be vacated, so moving into it is legal —
  // except when we just ate and the tail stays put.
  const ate = samePoint(nextHead, state.food);
  const body = ate ? state.snake : state.snake.slice(0, -1);
  const hitSelf = body.some((p) => samePoint(p, nextHead));

  if (hitWall || hitSelf) {
    return {
      next: { ...state, status: 'over' },
      event: { type: 'over', score: state.score },
    };
  }

  const snake = [nextHead, ...body];
  if (!ate) return { next: { ...state, snake } };

  return {
    next: {
      ...state,
      snake,
      food: placeFood(snake, random),
      score: state.score + 1,
    },
    event: { type: 'ate', length: snake.length },
  };
}

export interface UseSnakeOptions {
  /** Milliseconds per tick. */
  speedMs?: number;
  onEvent?: (event: SnakeEvent) => void;
  random?: () => number;
}

export function useSnake({ speedMs = 140, onEvent, random = Math.random }: UseSnakeOptions = {}) {
  const [state, setState] = useState<SnakeState>(() => initialState(random));
  // Direction changes land between ticks; queueing them stops a fast
  // double-tap from reversing the snake into itself within one tick.
  const queued = useRef<Direction[]>([]);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const start = useCallback(() => {
    queued.current = [];
    setState({ ...initialState(random), status: 'running' });
  }, [random]);

  const turn = useCallback((direction: Direction) => {
    queued.current.push(direction);
  }, []);

  useEffect(() => {
    if (state.status !== 'running') return;
    const timer = window.setInterval(() => {
      setState((prev) => {
        let direction = prev.direction;
        while (queued.current.length > 0) {
          const candidate = queued.current.shift()!;
          if (candidate !== OPPOSITE[direction]) {
            direction = candidate;
            break;
          }
        }
        const { next, event } = advance({ ...prev, direction }, random);
        if (event) onEventRef.current?.(event);
        return next;
      });
    }, speedMs);
    return () => window.clearInterval(timer);
  }, [state.status, speedMs, random]);

  return { state, start, turn };
}
