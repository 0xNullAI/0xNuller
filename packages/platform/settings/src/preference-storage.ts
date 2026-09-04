/** Recoverable ordinary preferences; safety records keep their own fail-closed store. */
const memory = new Map<string, string>();
const failures = new Map<string, string>();
const listeners = new Set<() => void>();
let warning = '';
export function reportPersistenceResult(key: string, ok: boolean): void {
  if (ok) failures.delete(key);
  else
    failures.set(
      key,
      '部分设置或日志无法保存，关闭应用后可能丢失。请检查存储空间或浏览器存储权限。',
    );
  const next = [...failures.values()][0] ?? '';
  if (next === warning) return;
  warning = next;
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}
export function persistenceWarning(): string {
  return warning;
}
export function subscribePersistenceWarning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function readPreference(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    reportPersistenceResult(key, false);
    return null;
  }
}
export function writePreference(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    memory.delete(key);
    reportPersistenceResult(key, true);
    return true;
  } catch {
    memory.set(key, value);
    reportPersistenceResult(key, false);
    return false;
  }
}
