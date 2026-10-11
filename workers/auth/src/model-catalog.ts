import { err, json } from './http';

/**
 * Public model catalog for the settings model picker, sourced from models.dev so the
 * product never maintains its own list of model ids, vision support or limits.
 *
 * The full models.dev file is several megabytes; browsers and the Android shell ask this
 * endpoint for only the providers they show and get a few kilobytes back. The upstream
 * file is cached at the edge and parsed at most once per isolate per refresh interval.
 */
const SOURCE = 'https://models.dev/api.json';
const REFRESH_MS = 60 * 60 * 1000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PROVIDERS = 40;

export interface CatalogModel {
  id: string;
  name: string;
  family: string | null;
  image: boolean;
  reasoning: boolean;
  temperature: boolean;
  toolCall: boolean;
  context: number | null;
  output: number | null;
  releaseDate: string | null;
}

type Upstream = Record<string, { models?: Record<string, Record<string, unknown>> }>;

let cached: { at: number; data: Upstream } | null = null;
let inflight: Promise<Upstream> | null = null;

/** Test hook: forget the isolate cache. */
export function resetModelCatalogCache(): void {
  cached = null;
  inflight = null;
}

async function upstream(fetcher: typeof fetch, now: number): Promise<Upstream> {
  if (cached && now - cached.at < REFRESH_MS) return cached.data;
  inflight ??= (async () => {
    const response = await fetcher(SOURCE, {
      cf: { cacheTtl: REFRESH_MS / 1000, cacheEverything: true },
    } as RequestInit);
    if (!response.ok) throw new Error(`models.dev ${response.status}`);
    const data = (await response.json()) as Upstream;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('models.dev shape');
    cached = { at: now, data };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Narrow one upstream entry to the fields the client uses; invalid entries are dropped. */
export function toCatalogModel(raw: Record<string, unknown>): CatalogModel | null {
  const id = text(raw.id, 200);
  if (!id) return null;
  const modalities = raw.modalities as { input?: unknown } | undefined;
  const limit = raw.limit as { context?: unknown; output?: unknown } | undefined;
  return {
    id,
    name: text(raw.name, 200) ?? id,
    family: text(raw.family, 100),
    image: Array.isArray(modalities?.input) && modalities.input.includes('image'),
    reasoning: raw.reasoning === true,
    // models.dev marks models that reject sampling parameters with `temperature: false`.
    temperature: raw.temperature !== false,
    toolCall: raw.tool_call === true,
    context: positive(limit?.context),
    output: positive(limit?.output),
    releaseDate: text(raw.release_date, 20),
  };
}

export async function handleModelCatalog(
  request: Request,
  headers: HeadersInit,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/auth/model-catalog') return null;
  if (request.method !== 'GET') return err('不支持此操作', 405, headers);
  const requested = [
    ...new Set((url.searchParams.get('providers') ?? '').split(',').filter(Boolean)),
  ];
  if (
    !requested.length ||
    requested.length > MAX_PROVIDERS ||
    !requested.every((id) => PROVIDER_ID.test(id))
  )
    return err('模型目录参数无效', 400, headers);
  let data: Upstream;
  try {
    data = await upstream(fetcher, now);
  } catch {
    return err('模型目录暂不可用', 503, headers);
  }
  const providers: Record<string, CatalogModel[]> = {};
  for (const id of requested) {
    const models = data[id]?.models;
    if (!models || typeof models !== 'object') continue;
    providers[id] = Object.values(models)
      .map((model) => (model && typeof model === 'object' ? toCatalogModel(model) : null))
      .filter((model): model is CatalogModel => model !== null);
  }
  return json({ source: 'models.dev', providers }, 200, {
    ...headers,
    'cache-control': 'public, max-age=3600',
  });
}
