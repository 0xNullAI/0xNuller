import { expect, it } from 'vitest';
import { mediaRefShape, mentionsShape, stateFrameShape } from './frame-shape';

it('rebuilds relayed state from known fields of the expected type only', () => {
  expect(stateFrameShape('presence', { t: 'presence', n: {}, extra: 1 })).toEqual({
    t: 'presence',
  });
  const ss = stateFrameShape('ss', {
    t: 'ss',
    n: 'Bob',
    u: null,
    cat: [{ id: 'w1', name: '呼吸', custom: 'yes' }, 5, { id: 2 }],
    qA: ['w1', 3],
    mA: 'list',
    iA: 0,
    sk: null,
    junk: 'x',
  });
  expect(ss).toEqual({
    t: 'ss',
    n: 'Bob',
    u: null,
    cat: [{ id: 'w1', name: '呼吸', custom: false }],
    qA: ['w1'],
    mA: 'list',
    iA: 1,
    sk: null,
  });
  expect(stateFrameShape('sf', { t: 'sf', sa: '9', sb: 4, se: null })).toEqual({
    t: 'sf',
    sb: 4,
    se: null,
  });
});

it('keeps only well-formed mentions and media this room could have issued', () => {
  expect(mentionsShape([null, { peerId: 'p', n: 'A' }, { peerId: 'q', n: {} }])).toEqual([
    { peerId: 'p', n: 'A' },
  ]);
  expect(mentionsShape([null])).toBeUndefined();
  expect(mediaRefShape(undefined)).toBeUndefined();
  expect(mediaRefShape({ kind: 'image', id: '../x', mime: 'image/jpeg', size: 1 })).toBeNull();
  expect(mediaRefShape({ kind: 'image', id: 'abc', mime: 'image/jpeg', size: 10, w: '1' })).toEqual(
    { kind: 'image', id: 'abc', mime: 'image/jpeg', size: 10 },
  );
});
