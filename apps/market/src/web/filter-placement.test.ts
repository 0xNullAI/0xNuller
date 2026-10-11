import { describe, expect, it } from 'vitest';
import { filterPlacement } from './filter-placement';

describe('Market filter placement', () => {
  it.each([
    {
      name: 'opens below when the menu fits',
      args: [{ top: 100, bottom: 144 }, 800],
      expected: { side: 'bottom', maxHeight: 632 },
    },
    {
      name: 'opens above a trigger near the viewport bottom and caps its scroll height',
      args: [{ top: 690, bottom: 734 }, 800],
      expected: { side: 'top', maxHeight: 666 },
    },
    {
      name: 'uses the larger available side in a short viewport',
      args: [{ top: 210, bottom: 254 }, 400],
      expected: { side: 'top', maxHeight: 186 },
    },
    {
      name: 'stays inside the scrollable module pane below the shell toolbar',
      args: [{ top: 210, bottom: 254 }, 800, 320, { top: 80, bottom: 540 }],
      expected: { side: 'bottom', maxHeight: 262 },
    },
  ] as Array<{ name: string; args: Parameters<typeof filterPlacement>; expected: unknown }>)(
    '$name',
    ({ args, expected }) => {
      expect(filterPlacement(...args)).toEqual(expected);
    },
  );
});
