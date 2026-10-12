import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The Workers runtime throws on `redirect: 'error'` before any request leaves, which
// Node's fetch (and so every mocked unit test) accepts. Only a source check catches it.
it('never asks the Workers fetch for redirect "error"', () => {
  const dir = new URL('.', import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => /\.ts$/.test(name) && !name.endsWith('.test.ts'))
    .filter((name) => /redirect:\s*['"]error['"]/.test(readFileSync(new URL(name, dir), 'utf8')));
  expect(offenders).toEqual([]);
});
