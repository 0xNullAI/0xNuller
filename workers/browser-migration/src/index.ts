const ENDPOINT = '/.well-known/0xnullai-browser-migration-v1';
const ALLOWED_PARENTS = ['https://0xnullai.com', 'https://www.0xnullai.com'];

const SOURCE_CONFIG: Record<string, { keys: string[]; prefixes?: string[]; databases: string[] }> =
  {
    'agent.0xnullai.com': {
      keys: [
        'dg-agent.browser-settings',
        'dg-agent.provider-settings',
        'dg-agent.provider-api-keys.local',
        'dg-agent.voice-api-key.local',
        'dg-agent.model-logs',
      ],
      databases: ['dg-agent', 'dg-agent-traces', 'dg-agent-waveforms'],
    },
    'chat.0xnullai.com': {
      keys: [
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
      ],
      prefixes: ['dg-chat-owner-key:'],
      databases: [],
    },
    'voice.0xnullai.com': {
      keys: ['dg-voice-settings'],
      databases: ['dg-voice-waveforms'],
    },
    'market.0xnullai.com': {
      keys: ['dg-market.theme'],
      databases: [],
    },
    'wiki.0xnullai.com': {
      keys: ['dg-wiki:theme'],
      databases: [],
    },
  };

const SHARED_KEYS = [
  '0xnullai.scenes',
  '0xnullai.llm-config',
  '0xnullai.device-safety',
  '0xnullai.theme',
  '0xnullai.proxy',
  '0xnullai.safety-accepted',
  'dg-bg-behavior',
];

function exporterScript(hostname: string): string {
  const config = SOURCE_CONFIG[hostname];
  if (!config) throw new Error('Unsupported migration source');
  return `
const VERSION = 1;
const SOURCE = ${JSON.stringify(hostname)};
const ALLOWED = new Set(${JSON.stringify(ALLOWED_PARENTS)});
const FIXED_KEYS = ${JSON.stringify([...config.keys, ...SHARED_KEYS])};
const PREFIXES = ${JSON.stringify(config.prefixes ?? [])};
const DATABASES = ${JSON.stringify(config.databases)};

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

async function dumpDatabase(name) {
  if (typeof indexedDB.databases === 'function') {
    const known = await indexedDB.databases();
    if (!known.some((db) => db.name === name)) return null;
  }
  const db = await request(indexedDB.open(name));
  const stores = [];
  for (const storeName of Array.from(db.objectStoreNames)) {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    stores.push({ name: storeName, entries: keys.map((key, index) => [key, values[index]]) });
  }
  db.close();
  return { name, stores };
}

async function collect() {
  const local = {};
  for (const key of FIXED_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) local[key] = value;
  }
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const value = localStorage.getItem(key);
    if (value !== null) local[key] = value;
  }
  const databases = [];
  for (const name of DATABASES) {
    try {
      const dumped = await dumpDatabase(name);
      if (dumped) databases.push(dumped);
    } catch {
      // A blocked or corrupt legacy database must not prevent the remaining data migrating.
    }
  }
  return { localStorage: local, databases };
}

window.addEventListener('message', async (event) => {
  if (!ALLOWED.has(event.origin) || event.source !== parent) return;
  const message = event.data;
  if (!message || message.type !== '0xnullai:migration-request' || message.version !== VERSION || typeof message.nonce !== 'string') return;
  try {
    const payload = await collect();
    parent.postMessage({ type: '0xnullai:migration-response', version: VERSION, source: SOURCE, nonce: message.nonce, payload }, event.origin);
  } catch {
    parent.postMessage({ type: '0xnullai:migration-response', version: VERSION, source: SOURCE, nonce: message.nonce, error: 'export-failed' }, event.origin);
  }
});
parent.postMessage({ type: '0xnullai:migration-ready', version: VERSION, source: SOURCE }, '*');
`;
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const config = SOURCE_CONFIG[url.hostname];
    if (!config || url.pathname !== ENDPOINT || request.method !== 'GET') {
      return new Response('Not found', { status: 404 });
    }
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>0xNullAI migration</title></head><body><script nonce="${nonce}">${exporterScript(url.hostname)}</script></body></html>`;
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors ${ALLOWED_PARENTS.join(' ')}`,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
} satisfies ExportedHandler;
