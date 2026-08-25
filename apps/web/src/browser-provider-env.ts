/**
 * Browser replacement for pi-ai's provider environment lookup. The upstream
 * module contains a Bun-only `/proc/self/environ` fallback and therefore imports
 * `node:fs`; that path can never run in this browser shell.
 */
export function getProviderEnvValue(
  name: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  const processEnv = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.[name] || processEnv?.[name] || undefined;
}
