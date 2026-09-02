#!/usr/bin/env node
/**
 * Check that no two Workers declare overlapping routes.
 *
 * Cloudflare matches the most specific route. A zone-root `/*` route is therefore
 * a valid static-site fallback behind more specific API routes; other overlaps are
 * rejected because they are easy to make ambiguous during maintenance.
 *
 * **The configs are discovered, not a hard-coded list.** The first version had four
 * Workers hard-coded, and the newly added dg-voice was never checked at all — a
 * script whose entire job is to prevent something being missed missed one itself,
 * and reported green.
 *
 * This script only does a static check; it is no substitute for probing the real
 * deployment.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', '.git', 'target', 'build']);

function findConfigs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    // Generated Android trees contain absolute library symlinks whose targets may
    // disappear after a clean. Route discovery never needs to follow symlinks.
    if (lstatSync(path).isDirectory()) findConfigs(path, out);
    else if (/^wrangler\.(jsonc?|toml)$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * wrangler.jsonc has comments and wrangler.toml is TOML — pull the fields out with
 * regexes in both cases, no dependencies.
 */
function parse(path) {
  const text = readFileSync(path, 'utf8');
  const name = text.match(/name"?\s*[:=]\s*"([^"]+)"/)?.[1] ?? path;
  const patterns = [...text.matchAll(/pattern"?\s*[:=]\s*"([^"]+)"/g)].map((m) => m[1]);
  return { name, path, patterns };
}

const workers = findConfigs(process.cwd()).map(parse);

// Only patterns with a path can overlap. Custom domains (all of `example.com`) are
// a separate matter.
const entries = workers.flatMap((w) =>
  w.patterns.filter((p) => p.includes('/')).map((p) => ({ worker: w.name, pattern: p })),
);

let failed = false;

function isZoneFallback(pattern) {
  return /^https?:\/\/[^/]+\/\*$/.test(pattern) || /^[^/]+\/\*$/.test(pattern);
}

for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i];
    const b = entries[j];
    if (a.worker === b.worker) continue;
    const pa = a.pattern.replace(/\*$/, '');
    const pb = b.pattern.replace(/\*$/, '');
    if (pa.startsWith(pb) || pb.startsWith(pa)) {
      if (isZoneFallback(a.pattern) || isZoneFallback(b.pattern)) continue;
      console.error(`✘ 路由重叠：${a.worker} "${a.pattern}"  ⟷  ${b.worker} "${b.pattern}"`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n仅允许根路径 /* 作为静态站点兜底；其余重叠路由必须拆分。');
  process.exit(1);
}

console.log(`✓ ${workers.length} 个 Worker，${entries.length} 条路径路由，无重叠\n`);
for (const w of workers) {
  const shown = w.patterns.length ? w.patterns.join('  ') : '（无 routes，仅 workers.dev）';
  console.log(`  ${w.name.padEnd(17)} ${shown}`);
}
