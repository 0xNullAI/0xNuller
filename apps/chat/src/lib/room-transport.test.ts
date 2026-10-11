import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectRoom } from './room-transport';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connect(dm = false) {
  let minted = 0;
  const ticket = vi.fn(async () => `ticket-${++minted}`);
  const transport = connectRoom({
    code: dm ? 'dm:abc' : 'group-room',
    peerId: 'peer',
    dm,
    ticket,
    onOpen: () => undefined,
    onMessage: () => undefined,
    onStatus: () => undefined,
  });
  await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0]!;
  socket.open();
  return { transport, socket, ticket };
}

it('renews the lease on the same socket only after the server advertises support', async () => {
  const { transport, socket } = await connect();
  await vi.advanceTimersByTimeAsync(60_000);
  // An older server would relay an unknown frame, ticket included, to the whole room.
  expect(socket.sent).toEqual([]);

  socket.receive({ t: 'media-auth', token: 'm', renew: true });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(socket.sent).toEqual([{ t: 'renew', ticket: 'ticket-2' }]);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(socket.sent).toHaveLength(2);
  expect(FakeSocket.instances).toHaveLength(1);

  transport.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(socket.sent).toHaveLength(2);
});

it('stops renewing a closed socket and never sends a ticket to its replacement early', async () => {
  const { transport, socket } = await connect();
  socket.receive({ t: 'media-auth', token: 'm', renew: true });
  socket.close();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(socket.sent).toEqual([]);
  const replacement = FakeSocket.instances.at(-1)!;
  expect(replacement).not.toBe(socket);
  replacement.open();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(replacement.sent).toEqual([]);
  transport.close();
});

it('connects a direct message to the DM endpoint and a group to its room endpoint', async () => {
  const dm = await connect(true);
  expect(dm.socket.url).toContain('/ws/dm?ticket=ticket-1');
  dm.transport.close();
  FakeSocket.instances = [];
  const group = await connect(false);
  expect(group.socket.url).toContain('/ws/room/group-room?');
  group.transport.close();
});
