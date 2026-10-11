// Builds the AI_PRICE_TABLE Worker secret from a private cost file kept outside the repository.
//
//   node scripts/build-ai-price-table.mjs ../Private/pricing/ai-costs.json > /secure/ai-price-table.json
//
// The cost file holds provider list prices in yuan, the multiplier and the Credit unit:
//   { "version": "...", "multiplier": n, "creditsPerYuan": n,
//     "chat": { "model": "...", "fallbackModel": "...", "inputPerMillion": yuan, ... }, ... }
// Every price in it is multiplied by multiplier × creditsPerYuan; ids and versions pass through.
// Nothing is printed except the resulting table, which is itself a secret.
import { readFileSync } from 'node:fs';
import { parsePriceTable } from '../packages/platform/ai-pricing/src/index.ts';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: build-ai-price-table.mjs <private-cost-file>');
const costs = JSON.parse(readFileSync(file, 'utf8'));
const factor = Number(costs.multiplier) * Number(costs.creditsPerYuan);
if (!Number.isFinite(factor) || factor <= 0)
  throw new Error('multiplier and creditsPerYuan required');

// Round up so a price can never fall below cost × multiplier.
const scale = (yuan) => Math.ceil(Number(yuan) * factor * 10_000) / 10_000;
const convert = (route) =>
  Object.fromEntries(
    Object.entries(route).map(([key, value]) =>
      typeof value === 'number' ? [key, scale(value)] : [key, value],
    ),
  );
const table = { version: costs.version };
for (const key of ['chat', 'vision', 'background', 'image', 'tts', 'asr', 'realtime'])
  table[key] = convert(costs[key] ?? {});
if (!parsePriceTable(table)) throw new Error('cost file is incomplete; refusing to emit a table');
process.stdout.write(JSON.stringify(table));
