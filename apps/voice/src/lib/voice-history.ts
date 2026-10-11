import type { ConversationTextMessage, PrivateConversationChannel } from '@0xnullai/auth';
import type { RealtimeTranscriptEntry } from './realtime/realtime-session';

/** Final text only. Retried provider events reuse an immutable ID and timestamp; audio never enters this boundary. */
export class VoiceConversationHistory {
  private queue: Promise<void> = Promise.resolve();
  private blocked = false;
  private disposed = false;
  private readonly rows = new Map<
    string,
    {
      text: string;
      message: Promise<ConversationTextMessage>;
      saved: boolean;
    }
  >();
  constructor(
    readonly channel: PrivateConversationChannel,
    private readonly callId: string = crypto.randomUUID(),
  ) {}
  /** Includes writes still in flight: a page close can abort them before acknowledgement. */
  get hasUnsaved(): boolean {
    return !this.disposed && Array.from(this.rows.values()).some((row) => !row.saved);
  }
  async record(entry: RealtimeTranscriptEntry): Promise<void> {
    if (!entry.done || !entry.text.trim()) return;
    const key = `${entry.role}:${entry.id}`;
    let row = this.rows.get(key);
    if (row && row.text !== entry.text) throw new Error('已完成字幕发生冲突，未覆盖服务器原消息。');
    if (!row) {
      const createdAt = Date.now();
      const message = crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(`${this.callId}:${key}`))
        .then((digest) => ({
          id: `voice-${Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')}`,
          role: entry.role,
          content: entry.text,
          createdAt,
        }));
      row = { text: entry.text, message, saved: false };
      this.rows.set(key, row);
    }
    await this.enqueue(async () => {
      if (this.blocked) throw new Error('前一条字幕尚未保存，请先重试。');
      try {
        await this.save(row);
      } catch (error) {
        this.blocked = true;
        throw error;
      }
    });
  }
  async retry(): Promise<void> {
    await this.enqueue(async () => {
      this.blocked = false;
      for (const row of this.rows.values()) {
        try {
          await this.save(row);
        } catch (error) {
          this.blocked = true;
          throw error;
        }
      }
    });
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(() => {
      if (this.disposed) throw new Error('通话已结束，不能再保存字幕。');
      return run();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async save(row: {
    message: Promise<ConversationTextMessage>;
    saved: boolean;
  }): Promise<void> {
    if (row.saved) return;
    await this.channel.append([await row.message]);
    row.saved = true;
  }
  dispose(): void {
    this.disposed = true;
    this.channel.dispose();
    this.rows.clear();
  }
}
