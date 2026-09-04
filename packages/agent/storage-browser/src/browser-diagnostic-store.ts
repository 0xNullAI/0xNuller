import { createStore, entries, keys, setMany, delMany, type UseStore } from 'idb-keyval';
/** Bounded callers provide their retained records; only changed records are written. */
export class BrowserDiagnosticStore<T extends { id: string }> {
  private store: UseStore | undefined;
  private previous = new Map<string, T>();
  private queue: Promise<unknown> = Promise.resolve();
  private database(): UseStore {
    return (this.store ??= createStore('dg-agent-diagnostics', 'model-turns'));
  }
  load(): Promise<T[]> {
    const run = async () => {
      const result = await entries<string, T>(this.database());
      this.previous = new Map(result);
      return result.map(([, value]) => value);
    };
    const pending = this.queue.then(run, run);
    this.queue = pending;
    return pending;
  }
  save(records: T[]): Promise<void> {
    const run = async () => {
      const next = new Map(records.map((record) => [record.id, record]));
      const writes = [...next].filter(([id, record]) => this.previous.get(id) !== record);
      // Clear/prune must also work before this instance has loaded the database.
      const persisted = await keys<string>(this.database());
      const removals = persisted.filter((id) => !next.has(id));
      if (writes.length) await setMany(writes, this.database());
      if (removals.length) await delMany(removals, this.database());
      this.previous = next;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending;
    return pending;
  }
}
