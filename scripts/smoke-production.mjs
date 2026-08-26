import { retry } from './lib/retry.mjs';

const base = (process.env.PRODUCTION_ORIGIN ?? 'https://0xnullai.com').replace(/\/$/, '');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const versionAttempts = Number(process.env.SMOKE_VERSION_ATTEMPTS ?? 6);
const versionRetryDelayMs = Number(process.env.SMOKE_VERSION_RETRY_DELAY_MS ?? 5_000);
const expectedVersion = process.env.EXPECTED_PRODUCT_VERSION;
const expectedBuildId = process.env.EXPECTED_BUILD_ID;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, expectedStatus) {
  const startedAt = performance.now();
  const response = await fetch(`${base}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': '0xNuller-production-smoke/1' },
  });
  const body = await response.text();
  assert(
    response.status === expectedStatus,
    `${path}: expected HTTP ${expectedStatus}, received ${response.status}: ${body.slice(0, 200)}`,
  );
  return { body, durationMs: Math.round(performance.now() - startedAt) };
}

function json(path, body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path}: response is not JSON`);
  }
}

const checks = [];

const { web } = await retry(
  async () => {
    const response = await request('/version.json', 200);
    const version = json('/version.json', response.body);
    assert(/^[0-9a-f]{40}$/.test(version.buildId), 'invalid Web buildId');
    if (expectedVersion) {
      assert(
        version.version === expectedVersion,
        `Web is ${version.version}, expected ${expectedVersion}`,
      );
    }
    if (expectedBuildId) {
      assert(
        version.buildId === expectedBuildId,
        `Web build is ${version.buildId}, expected ${expectedBuildId}`,
      );
    }
    return { web: response };
  },
  {
    attempts: versionAttempts,
    delayMs: versionRetryDelayMs,
    onRetry(error, attempt, attempts) {
      console.warn(
        `Web version not ready (${attempt}/${attempts}): ${error instanceof Error ? error.message : error}`,
      );
    },
  },
);
checks.push(['web', web.durationMs]);

const auth = await request('/api/auth/me', 200);
assert(json('/api/auth/me', auth.body).user === null, 'Auth anonymous session contract changed');
checks.push(['auth', auth.durationMs]);

const chat = await request('/api/lobby/rooms', 401);
assert(
  json('/api/lobby/rooms', chat.body).error === 'token required',
  'Chat admission gate failed',
);
checks.push(['chat', chat.durationMs]);

const market = await request('/api/items?limit=1', 200);
assert(Array.isArray(json('/api/items', market.body).items), 'Market items response is invalid');
checks.push(['market', market.durationMs]);

const seededScenario = await request('/api/items/mistbound-menagerie-guide', 200);
assert(
  json('/api/items/mistbound-menagerie-guide', seededScenario.body).item?.type === 'scenario',
  'Market release scenario is missing or invalid',
);
checks.push(['market-scenario', seededScenario.durationMs]);

const voice = await request('/api/realtime', 426);
assert(voice.body.includes('WebSocket upgrade'), 'Voice upgrade boundary changed');
checks.push(['voice', voice.durationMs]);

for (const [service, durationMs] of checks) {
  console.log(`${service}: ok (${durationMs} ms)`);
}
