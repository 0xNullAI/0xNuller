import type { CharacterDraft } from '../../shared/schema';

/** Serial CAS writes. Failure never advances revision or silently replaces a remote draft. */
export class CharacterStudioDraftSaver {
  private lifecycle = 0;
  private revision = 0;
  private initialized = false;
  private valid = true;
  private paused = false;
  private failed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private saved = '';
  private readonly write: (draft: CharacterDraft, revision: number) => Promise<number>;
  constructor(write: (draft: CharacterDraft, revision: number) => Promise<number>) {
    this.write = write;
  }
  initialize(revision: number, draft: CharacterDraft | null): void {
    this.assertCurrent();
    this.revision = revision;
    this.saved = draft ? JSON.stringify(draft) : '';
    this.initialized = true;
    this.failed = false;
  }
  assertCurrent(): void {
    if (!this.valid) throw new Error('账户已切换或编辑器已关闭，请重新打开');
  }
  attach(): () => void {
    const epoch = ++this.lifecycle;
    this.resume();
    return () => {
      this.pause();
      queueMicrotask(() => {
        if (this.lifecycle === epoch) this.dispose();
      });
    };
  }
  dispose(): void {
    this.valid = false;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  /** Last server revision this editor knows; 0 when the account has no draft. */
  currentRevision(): number {
    return this.revision;
  }
  isSaved(draft: CharacterDraft): boolean {
    return this.saved === JSON.stringify(draft);
  }
  save(draft: CharacterDraft, automatic = false): Promise<number | null> {
    const snapshot = JSON.parse(JSON.stringify(draft)) as CharacterDraft;
    const work = this.tail.then(async () => {
      this.assertCurrent();
      if (!this.initialized) throw new Error('在线草稿尚未读取完成，请稍后重试');
      if (automatic && (this.paused || this.failed)) return null;
      try {
        const revision = await this.write(snapshot, this.revision);
        this.assertCurrent();
        this.revision = revision;
        this.saved = JSON.stringify(snapshot);
        this.failed = false;
        return revision;
      } catch (error) {
        this.failed = true;
        throw error;
      }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}
