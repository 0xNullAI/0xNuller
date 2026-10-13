// @vitest-environment node
import { expect, it } from 'vitest';
import {
  agentTargets,
  describeTargets,
  snapshotFromFast,
  snapshotFromSlow,
  SNAPSHOT_TTL_MS,
  toolCommand,
  type PeerSnapshot,
} from './room-agent-tools';

const report = (extra: Record<string, unknown> = {}) => ({
  t: 'ss',
  n: 'Bob',
  dc: true,
  cy: [{ deviceId: 'd1' }],
  cat: [
    { id: 'w1', name: '呼吸' },
    { id: 'v1', name: '震动', modality: 'vibration' },
  ],
  oc: false,
  ag: ['a1', 'bad id!', 7],
  ...extra,
});

it('keeps only well-formed consent and electrostimulation waves from a current client', () => {
  const snapshot = snapshotFromSlow(undefined, 'bob', report(), 1000)!;
  expect(snapshot.allowed).toEqual(['a1']);
  expect(snapshot.waves).toEqual([{ id: 'w1', name: '呼吸' }]);
  expect(snapshot.coyote).toBe(true);
  expect(snapshotFromSlow(undefined, 'bob', { ...report(), ag: undefined }, 1000)).toBeUndefined();
  const fast = snapshotFromFast(snapshot, { sa: 7, sb: 'x' })!;
  expect([fast.strengthA, fast.strengthB]).toEqual([7, 0]);
  expect(snapshotFromFast(undefined, { sa: 7 })).toBeUndefined();
});

it('targets only fresh, connected, consenting members that are still here', () => {
  const snapshots = new Map<string, PeerSnapshot>([
    ['p-bob', snapshotFromSlow(undefined, 'bob', report(), 1000)!],
    ['p-old', snapshotFromSlow(undefined, 'old', report(), 1000 - SNAPSHOT_TTL_MS - 1)!],
    ['p-off', snapshotFromSlow(undefined, 'off', report({ dc: false, cy: [] }), 1000)!],
    ['p-gone', snapshotFromSlow(undefined, 'gone', report(), 1000)!],
  ]);
  const targets = agentTargets(snapshots, 'a1', 1000, (peerId) => peerId !== 'p-gone');
  expect(targets.map((target) => [target.label, target.peerId])).toEqual([['t1', 'p-bob']]);
  expect(agentTargets(snapshots, 'a2', 1000, () => true)).toEqual([]);
  expect(describeTargets(targets)).toContain('t1：「Bob」');
});

it('turns a tool call into a bounded command or a reason, never a guess', () => {
  const targets = agentTargets(
    new Map([['p-bob', snapshotFromSlow(undefined, 'bob', report(), 1000)!]]),
    'a1',
    1000,
    () => true,
  );
  const call = (name: string, args: unknown) => ({
    function: { name, arguments: JSON.stringify(args) },
  });
  expect(
    toolCommand(call('adjust_strength', { target: 't1', channel: 'A', delta: -99 }), targets),
  ).toMatchObject({ ok: true, command: { a: 'adjust_strength', c: 'A', v: -10 } });
  expect(
    toolCommand(call('set_wave', { target: 't1', channel: 'B', waveform: '呼吸' }), targets),
  ).toMatchObject({ ok: true, command: { a: 'change_wave', c: 'B', w: 'w1' } });
  expect(
    toolCommand(call('set_wave', { target: 't1', channel: 'B', waveform: '震动' }), targets),
  ).toMatchObject({ ok: false });
  expect(
    toolCommand(call('adjust_vibration', { target: 't1', channel: 'A', delta: 1 }), targets),
  ).toEqual({ ok: false, message: '对方没有连接负鼠' });
  expect(toolCommand(call('stop_all', { target: 't9' }), targets)).toMatchObject({ ok: false });
  expect(
    toolCommand(call('adjust_strength', { target: 't1', channel: 'C', delta: 1 }), targets),
  ).toMatchObject({ ok: false });
  expect(toolCommand({ function: { name: 'stop_all', arguments: '{' } }, targets)).toMatchObject({
    ok: false,
  });
  expect(toolCommand(call('alert', { target: 't1' }), targets)).toEqual({
    ok: false,
    message: '没有这个工具',
  });
});
