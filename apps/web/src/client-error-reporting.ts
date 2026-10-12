import { installClientErrorReporting } from '@0xnullai/observability/client-reporter';
import type { ClientErrorPlatform } from '@0xnullai/observability';
import { apiBaseUrl } from '@0xnullai/settings';
import { PRODUCT_BUILD_ID, PRODUCT_VERSION } from './product';

/**
 * Start sanitized client error reporting for this shell. Web and Android call this once at
 * startup with their platform; local dev and test builds never report.
 */
export function installShellErrorReporting(platform: ClientErrorPlatform): () => void {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } };
  if (meta.env?.DEV || meta.env?.MODE === 'test') return () => undefined;
  return installClientErrorReporting(window, {
    platform,
    version: PRODUCT_VERSION,
    buildId: PRODUCT_BUILD_ID,
    endpoint: `${apiBaseUrl()}/api/auth/client-errors`,
  });
}
