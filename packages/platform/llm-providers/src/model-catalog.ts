import { apiBaseUrl } from '@0xnullai/settings';
import type { ProviderId } from './index';

/**
 * Model metadata comes from models.dev (through the account service, which trims and
 * caches it). The product keeps only the mapping from its provider ids to models.dev
 * provider ids — never its own list of model ids, vision support or limits.
 */
export const MODELS_DEV_PROVIDER: Partial<Record<ProviderId, string>> = {
  qwen: 'alibaba-cn',
  deepseek: 'deepseek',
  doubao: 'volcengine',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  openrouter: 'openrouter',
  groq: 'groq',
  moonshotai: 'moonshotai',
  'moonshotai-cn': 'moonshotai-cn',
  zai: 'zai',
  'zai-coding-cn': 'zai-coding-plan',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
  xai: 'xai',
  cerebras: 'cerebras',
  together: 'togetherai',
  huggingface: 'huggingface',
  mistral: 'mistral',
  fireworks: 'fireworks-ai',
  xiaomi: 'xiaomi',
};

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

const RETRY_MS = 60_000;
let catalog: Record<string, CatalogModel[]> | null = null;
let loading: Promise<boolean> | null = null;
let failedAt = 0;
let version = 0;
const listeners = new Set<() => void>();

/** Changes whenever a catalog arrives; pairs with `subscribeModelCatalog` for React. */
export function getModelCatalogVersion(): number {
  return version;
}

/**
 * Loads the catalog once per page. Safe to call from any surface; concurrent calls share
 * one request, and a failure is retried no sooner than a minute later.
 */
export function loadModelCatalog(
  request: typeof fetch = (input, init) => fetch(input, init),
): Promise<boolean> {
  if (catalog) return Promise.resolve(true);
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  const providers = [...new Set(Object.values(MODELS_DEV_PROVIDER))].join(',');
  loading = request(`${apiBaseUrl()}/api/auth/model-catalog?providers=${providers}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { providers?: Record<string, CatalogModel[]> };
      if (!body.providers || typeof body.providers !== 'object') throw new Error('shape');
      catalog = body.providers;
      failedAt = 0;
      version += 1;
      for (const listener of listeners) listener();
      return true;
    })
    .catch(() => {
      failedAt = Date.now();
      return false;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Catalog models for one provider, or null while the catalog is unknown. */
export function getCatalogModels(providerId: ProviderId): readonly CatalogModel[] | null {
  if (!catalog) {
    void loadModelCatalog();
    return null;
  }
  const source = MODELS_DEV_PROVIDER[providerId];
  return source ? (catalog[source] ?? []) : [];
}

export function getCatalogModel(providerId: ProviderId, model: string): CatalogModel | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  return getCatalogModels(providerId)?.find((entry) => entry.id.toLowerCase() === id) ?? null;
}

/** Test hook. */
export function resetModelCatalogForTests(
  value: Record<string, CatalogModel[]> | null = null,
): void {
  catalog = value;
  loading = null;
  failedAt = 0;
  version += 1;
}
