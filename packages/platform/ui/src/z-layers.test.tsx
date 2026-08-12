import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dialog, DialogContent } from './components/dialog';
import { Sheet, SheetContent } from './components/sheet';
import { Z_OVERLAY, Z_OVERLAY_PANEL, Z_OVERLAY_POPOVER, Z_OVERLAY_STACKED } from './z-layers';

/**
 * Guards a bug that already shipped once.
 *
 * The backdrop was moved onto the z token (100) while the panel kept a
 * hand-written `z-50`. They are position:fixed siblings in one portal, so
 * the backdrop painted over the panel: the page dimmed and blurred with no
 * dialog visible, and Radix closed it on the next click. Build, typecheck,
 * lint and every existing test stayed green — jsdom does not do stacking,
 * and the class strings look fine read one at a time.
 *
 * So these assert the relationship between the two, which is the thing
 * that was actually wrong.
 */

afterEach(cleanup);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tokenSource = readFileSync(
  resolve(repositoryRoot, 'packages/platform/ui/src/styles/tokens.css'),
  'utf8',
);
const zTokens = new Map(
  [...tokenSource.matchAll(/(--z-[a-z-]+)\s*:\s*(\d+)\s*;/g)].map((match) => [
    match[1]!,
    Number(match[2]),
  ]),
);

function zIndexOf(className: string): number | null {
  const match = className.match(/z-\[var\((--z-[a-z-]+)\)\]/);
  return match ? (zTokens.get(match[1]!) ?? null) : null;
}

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      if (['dist', 'gen', 'node_modules'].includes(entry.name)) return [];
      return sourceFiles(child);
    }
    return /\.(?:css|html|ts|tsx)$/.test(entry.name) ? [child] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('弹窗层级', () => {
  it('全局层级按唯一语义顺序递增', () => {
    const order = [
      '--z-local-popover',
      '--z-floating-status',
      '--z-shell',
      '--z-shell-panel',
      '--z-shell-popover',
      '--z-module-overlay',
      '--z-overlay-panel',
      '--z-overlay-stacked',
      '--z-overlay-popover',
      '--z-toast',
      '--z-stop',
      '--z-native-overlay',
      '--z-splash',
      '--z-native-toast',
    ];

    for (let index = 1; index < order.length; index += 1) {
      expect(zTokens.get(order[index]!)).toBeGreaterThan(zTokens.get(order[index - 1]!)!);
    }
  });

  it('令牌本身：面板压过遮罩', () => {
    const overlay = zIndexOf(Z_OVERLAY);
    const panel = zIndexOf(Z_OVERLAY_PANEL);
    expect(overlay).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!).toBeGreaterThan(overlay!);
  });

  it('覆盖层里的下拉菜单压过普通与二级弹窗', () => {
    const overlay = zIndexOf(Z_OVERLAY);
    const popover = zIndexOf(Z_OVERLAY_POPOVER);

    expect(overlay).not.toBeNull();
    expect(popover).not.toBeNull();
    expect(popover!).toBeGreaterThan(zIndexOf(Z_OVERLAY_STACKED)!);
  });

  it('Dialog 的内容层压过它自己的遮罩', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    const zs = [...baseElement.querySelectorAll<HTMLElement>('*')]
      .map((n) => zIndexOf(typeof n.className === 'string' ? n.className : ''))
      .filter((z): z is number => z !== null);

    // Backdrop and panel are the two fixed layers; the panel must be last.
    expect(zs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...zs)).toBe(zIndexOf(Z_OVERLAY_PANEL));
  });

  it('Sheet 的内容层压过它自己的遮罩', () => {
    const { baseElement } = render(
      <Sheet open>
        <SheetContent>内容</SheetContent>
      </Sheet>,
    );

    const zs = [...baseElement.querySelectorAll<HTMLElement>('*')]
      .map((n) => zIndexOf(typeof n.className === 'string' ? n.className : ''))
      .filter((z): z is number => z !== null);

    expect(zs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...zs)).toBe(zIndexOf(Z_OVERLAY_PANEL));
  });

  it('没有裸 z-50 残留——那正是当初写坏的写法', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    expect(baseElement.querySelector('.z-50')).toBeNull();
  });

  it('产品源码不再引入硬编码层级', () => {
    const roots = [
      resolve(repositoryRoot, 'apps'),
      resolve(repositoryRoot, 'packages/platform'),
      resolve(repositoryRoot, 'android/app/src'),
      resolve(repositoryRoot, 'android/app/index.html'),
    ];
    const violations: string[] = [];

    for (const file of roots.flatMap(sourceFiles)) {
      if (/\.(?:test|spec)\.[^.]+$/.test(file)) continue;
      if (file.endsWith('/z-layers.ts') || file.endsWith('/styles/tokens.css')) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      if (/\bz-(?:\d+|\[\s*\d+\s*\])/.test(source)) violations.push(file);
      if (/\bz-index\s*:\s*\d+/.test(source)) violations.push(file);
      if (/\bzIndex\s*:\s*['"`]??\d+/.test(source)) violations.push(file);
    }

    expect([...new Set(violations)].map((file) => file.replace(`${repositoryRoot}/`, ''))).toEqual(
      [],
    );
  });
});
