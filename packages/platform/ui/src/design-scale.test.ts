import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A source-level guard, not a behavior test.
 *
 * Radius and duration are the two visual properties that drift without
 * anybody deciding to change them: whoever writes the next dialog picks a
 * number that looks right in isolation, and it does look right in isolation.
 * The damage only shows up side by side, and by then it is a hundred call
 * sites.
 *
 * That is what happened across the merge. The shared tokens said 12/16/22/28
 * while the four modules had independently converged on 4/6/7/8/10/12/14/16/20,
 * so two dialogs one click apart differed by 6px; durations ran to eleven
 * values in two notations. Each number was defensible on its own; having all
 * of them was not.
 *
 * Both are now always tokens. The rule is enforced against the source text
 * because nothing else catches it — a hardcoded radius or duration
 * typechecks, lints, builds and renders perfectly.
 */

// vitest runs from the repo root (single root config, projects underneath).
const REPO_ROOT = process.cwd();

const SCANNED = [
  'apps/agent/src',
  'apps/chat/src',
  'apps/control/src',
  'apps/market/src/web',
  'apps/playground/src',
  'apps/voice/src',
  'apps/web/src',
  'packages/platform',
  'android/app/src',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.vite']);

/** The one file allowed to state the scales, because it is the scales. */
const TOKEN_FILE = 'packages/platform/ui/src/styles/tokens.css';

/** Tailwind arbitrary radius with a literal length: `rounded-[10px]`, `rounded-tl-[4px]`. */
const HARDCODED_UTILITY = /\brounded-(?:[a-z]{1,2}-)?\[\d*\.?\d+(?:px|rem|em)\]/g;

const CSS_DECLARATION = /border-radius:([^;]*);/g;

/**
 * Whether a `border-radius` value is drift. Three forms are not, and are
 * judged on the value rather than by pattern-matching the line, because a
 * lookahead that has to exclude them backtracks into matching them anyway:
 * `50%` / `999px` say "circle" and "pill", which are shapes rather than steps
 * on the scale, and `0` is a reset.
 */
function isRawRadius(value: string): boolean {
  const v = value.trim();
  if (v === '' || v === '0' || v === 'none' || v === 'inherit') return false;
  if (v.includes('var(')) return false;
  return !/^(?:0|50%|999px|\s)+$/.test(v);
}

/** Tailwind duration with a literal value: `duration-150`, `duration-[200ms]`. */
const HARDCODED_DURATION = /\bduration-(?:\d+|\[\d*\.?\d+m?s\])/g;

/**
 * A sub-second time anywhere in a stylesheet. In CSS a time only ever appears
 * in a timing position, and the shorthand is routinely wrapped across lines,
 * so matching the value rather than the declaration is both simpler and more
 * complete. Ambient motion (spinners, background drift) is written in whole
 * seconds and is deliberately not on this scale.
 */
const SUBSECOND = /(?<![\w.-])(?:0?\.\d+s|\d{1,3}ms)(?![\w-])/g;

/** Escape hatch: a value that genuinely is not on either scale. */
const ALLOWED_RAW = /\/\*\s*allow-raw-(?:radius|duration)\s*\*\//;

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
    if (SKIP_DIRS.has(name)) continue;
    const full = join(abs, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(join(dir, name)));
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCANNED.flatMap(sourceFiles);

function scan(report: (line: string, isCss: boolean) => string[]): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    if (file.endsWith(TOKEN_FILE)) continue;
    const isCss = file.endsWith('.css');
    let lineNo = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      lineNo += 1;
      if (ALLOWED_RAW.test(line)) continue;
      for (const hit of report(line, isCss)) {
        found.push(`${file.replace(REPO_ROOT + '/', '')}:${lineNo} ${hit}`);
      }
    }
  }
  return found;
}

const utilityOffenders = () => scan((line) => line.match(HARDCODED_UTILITY) ?? []);

const cssRadiusOffenders = () =>
  scan((line) =>
    [...line.matchAll(CSS_DECLARATION)]
      .filter((m) => isRawRadius(m[1] ?? ''))
      .map((m) => m[0].trim()),
  );

const durationOffenders = () =>
  scan((line, isCss) => [
    ...(line.match(HARDCODED_DURATION) ?? []),
    ...(isCss ? (line.match(SUBSECOND) ?? []) : []),
  ]);

describe('圆角与动效各只有一套尺度', () => {
  it('扫到了源码——空列表会让这条守卫静默失效', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('没有写死像素的 rounded-[…] 工具类', () => {
    expect(utilityOffenders()).toEqual([]);
  });

  it('CSS 里的 border-radius 一律走令牌（圆形与胶囊除外）', () => {
    expect(cssRadiusOffenders()).toEqual([]);
  });

  it('动效时长一律走令牌（1s 以上的环境动画除外）', () => {
    expect(durationOffenders()).toEqual([]);
  });

  it('这条守卫真的能发现问题', () => {
    // Mutation check: the rules have to fire on the shapes they claim to
    // catch, or the assertions above pass by being blind.
    expect('class="rounded-[10px] p-2"'.match(HARDCODED_UTILITY)).toEqual(['rounded-[10px]']);
    expect('rounded-tl-[4px]'.match(HARDCODED_UTILITY)).toEqual(['rounded-tl-[4px]']);
    expect('rounded-[var(--radius-ctl)]'.match(HARDCODED_UTILITY)).toBeNull();
    expect('rounded-full'.match(HARDCODED_UTILITY)).toBeNull();

    expect(isRawRadius(' 7px')).toBe(true);
    expect(isRawRadius(' 0 8px 8px 0')).toBe(true);
    expect(isRawRadius(' var(--radius-ctl)')).toBe(false);
    expect(isRawRadius(' 0 var(--radius-xs) var(--radius-xs) 0')).toBe(false);
    expect(isRawRadius(' 50%')).toBe(false);
    expect(isRawRadius(' 999px')).toBe(false);
    expect(isRawRadius(' 0')).toBe(false);

    expect('transition-colors duration-150'.match(HARDCODED_DURATION)).toEqual(['duration-150']);
    expect('duration-[200ms]'.match(HARDCODED_DURATION)).toEqual(['duration-[200ms]']);
    expect('duration-[var(--dur)]'.match(HARDCODED_DURATION)).toBeNull();

    expect('  transition: color .15s ease;'.match(SUBSECOND)).toEqual(['.15s']);
    expect('    border-color 160ms ease,'.match(SUBSECOND)).toEqual(['160ms']);
    expect('  transition: color var(--dur) ease;'.match(SUBSECOND)).toBeNull();
    // Ambient motion and easing curves must not read as drift.
    expect('  animation: spin 2s linear infinite;'.match(SUBSECOND)).toBeNull();
    expect('  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);'.match(SUBSECOND)).toBeNull();
  });
});
