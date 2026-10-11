import { describe, expect, it } from 'vitest';
import { filterPlacement } from './filter-placement';

describe('Market filter placement', () => {
  it('opens below when the menu fits', () => {
    expect(filterPlacement({ top: 100, bottom: 144 }, 800)).toEqual({
      side: 'bottom',
      maxHeight: 632,
    });
  });

  it('opens above a trigger near the viewport bottom and caps its scroll height', () => {
    expect(filterPlacement({ top: 690, bottom: 734 }, 800)).toEqual({
      side: 'top',
      maxHeight: 666,
    });
  });

  it('uses the larger available side in a short viewport', () => {
    expect(filterPlacement({ top: 210, bottom: 254 }, 400)).toEqual({
      side: 'top',
      maxHeight: 186,
    });
  });

  it('stays inside the scrollable module pane below the shell toolbar', () => {
    expect(filterPlacement({ top: 210, bottom: 254 }, 800, 320, { top: 80, bottom: 540 })).toEqual({
      side: 'bottom',
      maxHeight: 262,
    });
  });
});
