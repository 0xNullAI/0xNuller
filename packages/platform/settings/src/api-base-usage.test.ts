import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A source-level guard, not a behavior test.
 *
 * `apiBaseUrl` / `apiWsUrl` exist because the Tauri WebView's origin is a
 * local scheme: a same-origin relative path resolves against
 * `tauri.localhost` rather than the deployment, so the request never
 * reaches the backend. The failure is invisible on the web and invisible in
 * every unit test, because it only appears once the code is packaged into
 * the APK — and Android has no hot update, so the broken build then lives
 * on users' phones.
 *
 * That has now happened twice: first in trial voice (`buildWsUrl` composed
 * a same-origin wss from `location.host`), then across Chat's room socket,
 * lobby and media upload plus every Market API call, which shipped bare
 * relative paths. Both times the code looked correct in review.
 *
 * So the rule is enforced against the source text: inside module code, an
 * API or WebSocket URL must go through the helpers. Nothing else catches
 * it before someone installs the APK.
 */

// vitest runs from the repo root (single root config, projects underneath).
const REPO_ROOT = process.cwd();

const SCANNED = [
  'apps/chat/src',
  'apps/market/src/web',
  'apps/voice/src',
  'apps/agent/src',
  'apps/web/src',
  'android/app/src',
];

/** Same-origin WebSocket assembled by hand. */
const HANDMADE_WS = /`\$\{\s*(proto|protocol|scheme)[^`]*\}\/\/\$\{\s*location\.host/;

/** `fetch('/api/...')` or fetch(`/api/...`) — a relative API path. */
const RELATIVE_API_FETCH = /fetch\(\s*(['"`])\/(api|ws)\//;

function sourceFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return out; // directory not present in this checkout
  }
  for (const name of entries) {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(join(dir, name)));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('后端地址一律走 apiBaseUrl / apiWsUrl', () => {
  const files = SCANNED.flatMap(sourceFiles);

  it('扫到了源码——空列表会让这条守卫静默失效', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('没有手工拼的同源 WebSocket 地址', () => {
    const offenders = files.filter((f) => HANDMADE_WS.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(REPO_ROOT + '/', ''))).toEqual([]);
  });

  it('没有指向 /api 或 /ws 的相对 fetch', () => {
    const offenders = files.filter((f) => RELATIVE_API_FETCH.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(REPO_ROOT + '/', ''))).toEqual([]);
  });
});
