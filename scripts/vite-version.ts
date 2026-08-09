/// <reference types="node" />

/**
 * Build identity, shared by every shell that ships one.
 *
 * Agent's update checker compares the compiled-in `__BUILD_ID__` against the
 * `buildId` inside `version.json`; a mismatch is what it reports as "a new
 * version is available". So the constant and the asset have to be produced by
 * the same code — and they were duplicated across apps/agent, apps/web and
 * android/app, where the shell's own copy already drifted to a different
 * local prefix. Two copies of a comparison is how you get a shell that
 * announces an update on every reload.
 *
 * Lives in scripts/ rather than a workspace package: vite configs are build
 * tooling, above the app source trees, and nothing ships this to a browser.
 */
import type { Plugin } from 'vite';

/**
 * CI builds are identified by the commit; `localPrefix` only labels builds
 * made outside it, and stays per-app ('local' for the web shells, 'tauri' for
 * the Android one) because that label is how you tell them apart in a bug
 * report.
 */
export function resolveBuildId(localPrefix: string): string {
  return (
    process.env.SOURCE_BUILD_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    `${localPrefix}-${Date.now()}`
  );
}

/** Emits the `version.json` the update checker polls, next to the bundle. */
export function emitVersionJson(buildId: string): Plugin {
  return {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId }, null, 2),
      });
    },
  };
}
