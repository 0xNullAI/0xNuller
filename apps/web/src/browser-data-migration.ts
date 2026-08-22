const VERSION = 1;
const ENDPOINT = '/.well-known/0xnullai-browser-migration-v1';
const MARKER_PREFIX = '0xnullai.cross-origin-migration.v1:';
const REQUEST_TIMEOUT_MS = 4_000;

const SOURCES = [
  {
    origin: 'https://agent.0xnullai.com',
    keys: new Set([
      'dg-agent.browser-settings',
      'dg-agent.provider-settings',
      'dg-agent.provider-api-keys.local',
      'dg-agent.voice-api-key.local',
      'dg-agent.model-logs',
    ]),
    prefixes: [] as string[],
    databases: new Set(['dg-agent', 'dg-agent-traces', 'dg-agent-waveforms']),
  },
  {
    origin: 'https://chat.0xnullai.com',
    keys: new Set([
      'dg-chat-name',
      'dg-chat-allow-ai',
      'dg-chat-ai-config',
      'dg-chat-groups',
      'dg-chat-groups-account-migrated-v1',
      'dg-chat-dm-read',
      'dg-chat-custom-waveforms',
      'dg-chat-hidden-builtins',
      'dg-fire-policy',
      'dg-chat-safety-accepted',
    ]),
    prefixes: ['dg-chat-owner-key:'],
    databases: new Set<string>(),
  },
  {
    origin: 'https://voice.0xnullai.com',
    keys: new Set(['dg-voice-settings']),
    prefixes: [] as string[],
    databases: new Set(['dg-voice-waveforms']),
  },
  {
    origin: 'https://market.0xnullai.com',
    keys: new Set(['dg-market.theme']),
    prefixes: [] as string[],
    databases: new Set<string>(),
  },
  {
    origin: 'https://wiki.0xnullai.com',
    keys: new Set(['dg-wiki:theme']),
    prefixes: [] as string[],
    databases: new Set<string>(),
  },
] as const;

const SHARED_KEYS = new Set([
  '0xnullai.scenes',
  '0xnullai.llm-config',
  '0xnullai.device-safety',
  '0xnullai.theme',
  '0xnullai.proxy',
  '0xnullai.safety-accepted',
  'dg-bg-behavior',
]);

interface DumpedStore {
  name: string;
  entries: [IDBValidKey, unknown][];
}

interface DumpedDatabase {
  name: string;
  stores: DumpedStore[];
}

interface MigrationPayload {
  localStorage: Record<string, string>;
  databases: DumpedDatabase[];
}

function isPayload(value: unknown): value is MigrationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<MigrationPayload>;
  return (
    !!payload.localStorage &&
    typeof payload.localStorage === 'object' &&
    Array.isArray(payload.databases)
  );
}

function marker(origin: string): string {
  return `${MARKER_PREFIX}${new URL(origin).hostname}`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(name: string, stores: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const first = indexedDB.open(name);
    first.onupgradeneeded = () => {
      for (const store of stores) {
        if (!first.result.objectStoreNames.contains(store)) first.result.createObjectStore(store);
      }
    };
    first.onerror = () => reject(first.error ?? new Error('IndexedDB open failed'));
    first.onsuccess = () => {
      const db = first.result;
      const missing = stores.filter((store) => !db.objectStoreNames.contains(store));
      if (missing.length === 0) {
        resolve(db);
        return;
      }
      const nextVersion = db.version + 1;
      db.close();
      const upgrade = indexedDB.open(name, nextVersion);
      upgrade.onupgradeneeded = () => {
        for (const store of missing) upgrade.result.createObjectStore(store);
      };
      upgrade.onerror = () => reject(upgrade.error ?? new Error('IndexedDB upgrade failed'));
      upgrade.onsuccess = () => resolve(upgrade.result);
    };
  });
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mergeObjectTimestamps(current: string | null, legacy: string): string | null {
  const left = parseObject(current);
  const right = parseObject(legacy);
  if (!right) return current;
  if (!left) return legacy;
  const merged = { ...right, ...left };
  for (const [key, value] of Object.entries(right)) {
    if (typeof value === 'number' && typeof left[key] === 'number') {
      merged[key] = Math.max(value, left[key] as number);
    }
  }
  return JSON.stringify(merged);
}

function mergeArrayByField(current: string | null, legacy: string, field: string): string | null {
  try {
    const left: unknown = current ? JSON.parse(current) : [];
    const right: unknown = JSON.parse(legacy);
    if (!Array.isArray(right)) return current;
    if (!Array.isArray(left)) return legacy;
    const seen = new Set(
      left
        .map((item) =>
          item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined,
        )
        .filter((value): value is string => typeof value === 'string'),
    );
    return JSON.stringify([
      ...left,
      ...right.filter((item) => {
        const value =
          item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined;
        return typeof value !== 'string' || !seen.has(value);
      }),
    ]);
  } catch {
    return current;
  }
}

export function mergeLegacyLocalValue(
  key: string,
  current: string | null,
  legacy: string,
): string | null {
  if (key === 'dg-chat-groups') return mergeArrayByField(current, legacy, 'code');
  if (key === 'dg-chat-dm-read') return mergeObjectTimestamps(current, legacy);
  if (key === '0xnullai.scenes') return mergeArrayByField(current, legacy, 'id');
  return current ?? legacy;
}

async function mergeDatabase(database: DumpedDatabase): Promise<void> {
  const db = await openDatabase(
    database.name,
    database.stores.map((store) => store.name),
  );
  try {
    for (const dumpedStore of database.stores) {
      const tx = db.transaction(dumpedStore.name, 'readwrite');
      const store = tx.objectStore(dumpedStore.name);
      for (const [key, legacy] of dumpedStore.entries) {
        const current = await request(store.get(key));
        let next = current === undefined ? legacy : current;
        if (key === 'custom-waveforms' && Array.isArray(current) && Array.isArray(legacy)) {
          const seen = new Set(
            current
              .map((item) =>
                item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined,
              )
              .filter((id): id is string => typeof id === 'string'),
          );
          next = [
            ...current,
            ...legacy.filter((item) => {
              const id =
                item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined;
              return typeof id !== 'string' || !seen.has(id);
            }),
          ];
        } else if (
          database.name === 'dg-agent' &&
          current &&
          legacy &&
          typeof current === 'object' &&
          typeof legacy === 'object'
        ) {
          const currentTime = Number((current as Record<string, unknown>).updatedAt ?? 0);
          const legacyTime = Number((legacy as Record<string, unknown>).updatedAt ?? 0);
          if (legacyTime > currentTime) next = legacy;
        }
        if (next !== current) await request(store.put(next, key));
      }
    }
  } finally {
    db.close();
  }
}

async function clearWaveformMigrationMarker(): Promise<void> {
  const db = await openDatabase('0xnullai-waveforms', ['waveforms']);
  try {
    const tx = db.transaction('waveforms', 'readwrite');
    await request(tx.objectStore('waveforms').delete('migrated-from-per-module'));
  } finally {
    db.close();
  }
}

async function importPayload(
  source: (typeof SOURCES)[number],
  payload: MigrationPayload,
): Promise<void> {
  for (const [key, legacy] of Object.entries(payload.localStorage)) {
    const allowed =
      (source.keys as ReadonlySet<string>).has(key) ||
      SHARED_KEYS.has(key) ||
      source.prefixes.some((prefix) => key.startsWith(prefix));
    if (!allowed || typeof legacy !== 'string') continue;
    const next = mergeLegacyLocalValue(key, localStorage.getItem(key), legacy);
    if (next !== null) localStorage.setItem(key, next);
  }

  let importedWaveforms = false;
  for (const database of payload.databases) {
    if (
      !(source.databases as ReadonlySet<string>).has(database.name) ||
      !Array.isArray(database.stores)
    )
      continue;
    await mergeDatabase(database);
    if (database.name.endsWith('-waveforms')) importedWaveforms = true;
  }
  if (importedWaveforms) await clearWaveformMigrationMarker();
}

function fetchPayload(source: (typeof SOURCES)[number]): Promise<MigrationPayload | null> {
  if (localStorage.getItem(marker(source.origin)) === 'done') return Promise.resolve(null);
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = '旧版本数据迁移';
    const nonce = crypto.randomUUID();
    const finish = (payload: MigrationPayload | null) => {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(payload);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== source.origin || event.source !== frame.contentWindow) return;
      const message = event.data as Record<string, unknown> | null;
      if (!message || message.version !== VERSION) return;
      if (message.type === '0xnullai:migration-ready') {
        frame.contentWindow?.postMessage(
          { type: '0xnullai:migration-request', version: VERSION, nonce },
          source.origin,
        );
        return;
      }
      if (
        message.type === '0xnullai:migration-response' &&
        message.nonce === nonce &&
        message.source === new URL(source.origin).hostname &&
        isPayload(message.payload)
      ) {
        finish(message.payload);
      }
    };
    const timeout = window.setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    frame.src = `${source.origin}${ENDPOINT}`;
    document.body.append(frame);
  });
}

/** Import old subdomain storage before any feature store reads its migration markers. */
export async function runLegacyBrowserMigration(): Promise<void> {
  const payloads = await Promise.all(SOURCES.map(fetchPayload));
  for (const [index, source] of SOURCES.entries()) {
    const payload = payloads[index];
    if (!payload) continue;
    try {
      await importPayload(source, payload);
      localStorage.setItem(marker(source.origin), 'done');
    } catch {
      // Leave the source unmarked so a transient storage failure retries next load.
    }
  }
}
