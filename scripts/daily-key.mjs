#!/usr/bin/env node
// Prints the DG-Voice 体验版 daily activation key for a given AOE date — the
// exact value the Worker derives and emails. Use it to verify derivation or to
// grab a key without waiting for the cron email. Must match worker/daily-key.ts.
//
// Usage:
//   TRIAL_DAILY_SEED=... node scripts/daily-key.mjs [--date YYYY-MM-DD]
//   node scripts/daily-key.mjs --seed <seed> [--date YYYY-MM-DD]
//
// The seed is a secret: prefer the env var so it doesn't land in shell history.
// Generate one once with: openssl rand -base64 32
import { createHmac } from 'node:crypto';

const AOE_OFFSET_MS = 12 * 60 * 60 * 1000;
const HMAC_DOMAIN = 'dg-voice-trial';
const HASH_LEN = 32;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const seed = (arg('--seed') ?? process.env.TRIAL_DAILY_SEED ?? '').trim();
if (!seed) {
  console.error('缺少种子：设置 TRIAL_DAILY_SEED 环境变量，或用 --seed <seed>');
  process.exit(1);
}

const aoeDate = (now) => new Date(now - AOE_OFFSET_MS).toISOString().slice(0, 10);
const date = arg('--date') ?? aoeDate(Date.now());
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('--date 必须是 YYYY-MM-DD');
  process.exit(1);
}

const hash = createHmac('sha256', seed)
  .update(`${HMAC_DOMAIN}|${date}`)
  .digest('base64url')
  .slice(0, HASH_LEN);
const key = `dgv-daily-${date.replaceAll('-', '')}-${hash}`;

console.log(`\nAOE ${date} 的体验版激活密钥：`);
console.log(`  ${key}\n`);
