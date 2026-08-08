#!/usr/bin/env node
/**
 * 核对所有 Worker 的路由不重叠。
 *
 * 为什么需要它：Cloudflare 按最长前缀匹配，两个 Worker 声明了重叠的路径时不会报错
 * ——只是其中一个静默收不到请求。表现是「某个接口 404，但配置看起来是对的」。
 *
 * **配置是自动发现的，不是写死的列表。** 第一版写死了四个 Worker，结果新加的
 * dg-voice 压根没被检查——一个「专门防止漏掉」的脚本自己漏掉了一个，还报了绿。
 *
 * 这个脚本只做静态核对，代替不了真实部署后的探活。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', '.git', 'target', 'build']);

function findConfigs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) findConfigs(path, out);
    else if (/^wrangler\.(jsonc?|toml)$/.test(name)) out.push(path);
  }
  return out;
}

/** wrangler.jsonc 有注释，wrangler.toml 是 TOML——都用正则取字段，不引依赖。 */
function parse(path) {
  const text = readFileSync(path, 'utf8');
  const name = text.match(/name"?\s*[:=]\s*"([^"]+)"/)?.[1] ?? path;
  const patterns = [...text.matchAll(/pattern"?\s*[:=]\s*"([^"]+)"/g)].map((m) => m[1]);
  return { name, path, patterns };
}

const workers = findConfigs(process.cwd()).map(parse);

// 只有带路径的模式才可能重叠。自定义域（`example.com` 整站）单独看。
const entries = workers.flatMap((w) =>
  w.patterns.filter((p) => p.includes('/')).map((p) => ({ worker: w.name, pattern: p })),
);

let failed = false;

for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i];
    const b = entries[j];
    if (a.worker === b.worker) continue;
    const pa = a.pattern.replace(/\*$/, '');
    const pb = b.pattern.replace(/\*$/, '');
    if (pa.startsWith(pb) || pb.startsWith(pa)) {
      console.error(`✘ 路由重叠：${a.worker} "${a.pattern}"  ⟷  ${b.worker} "${b.pattern}"`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n重叠的路由中会有一个静默收不到请求——表现是接口 404 而配置看起来是对的。');
  process.exit(1);
}

console.log(`✓ ${workers.length} 个 Worker，${entries.length} 条路径路由，无重叠\n`);
for (const w of workers) {
  const shown = w.patterns.length ? w.patterns.join('  ') : '（无 routes，仅 workers.dev）';
  console.log(`  ${w.name.padEnd(17)} ${shown}`);
}
