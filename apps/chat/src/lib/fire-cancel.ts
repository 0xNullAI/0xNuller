type Channel = 'A' | 'B';

/**
 * Fire holds that a stop cancelled. A controller still pressing 开火 keeps sending a heartbeat
 * every 300 ms; without this, the first heartbeat after 归零 or an emergency stop would start a
 * fresh hold and put the output straight back up. A cancelled hold is ignored until that
 * controller lets go (fire_release) or its heartbeats stop for `ttlMs`; pressing again after
 * that starts a new hold as usual.
 */
export class CancelledFireHolds {
  private readonly held = new Map<string, number>();

  cancel(channel: Channel, peers: Iterable<string>, now: number): void {
    for (const peer of peers) this.held.set(`${channel}:${peer}`, now);
  }

  /** True when this heartbeat belongs to a cancelled hold; the caller must drop it. */
  swallow(channel: Channel, peer: string, now: number): boolean {
    const key = `${channel}:${peer}`;
    if (!this.held.has(key)) return false;
    this.held.set(key, now);
    return true;
  }

  release(channel: Channel, peer: string): void {
    this.held.delete(`${channel}:${peer}`);
  }

  expire(now: number, ttlMs: number): void {
    for (const [key, seen] of this.held) if (now - seen > ttlMs) this.held.delete(key);
  }

  clear(): void {
    this.held.clear();
  }
}
