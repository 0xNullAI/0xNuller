#!/usr/bin/env node
// Generates a DG-Voice 体验版 activation key and prints the JSON entry to merge
// into the Worker's `TRIAL_KEYS` secret.
//
// Usage:
//   node scripts/gen-trial-key.mjs [--daily <minutes>] [--days <validFor>]
//
// Then merge the printed entry into TRIAL_KEYS and push it:
//   wrangler secret put TRIAL_KEYS   # paste the full JSON object
//
// The key is a bearer token: anyone holding it can spend your xAI credit up to
// its caps. Distribute over a private channel and revoke by removing its entry
// (or setting `"enabled": false`).
import { randomBytes } from 'node:crypto';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const dailyRaw = arg('--daily');
const daysRaw = arg('--days');

const key = `dgv-trial-${randomBytes(12).toString('base64url')}`;

const entry = {};
if (dailyRaw !== undefined) {
  const daily = Number(dailyRaw);
  if (!Number.isFinite(daily) || daily <= 0) {
    console.error('--daily 必须是正数（分钟）');
    process.exit(1);
  }
  entry.dailyCapMinutes = Math.floor(daily);
}
if (daysRaw !== undefined) {
  const days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days 必须是正数（有效天数）');
    process.exit(1);
  }
  entry.expiresAt = Date.now() + Math.floor(days) * 86_400_000;
}

console.log('\n激活密钥（发给用户，填进「体验版」的激活密钥框）：');
console.log(`  ${key}\n`);
console.log('合并进 TRIAL_KEYS 的条目：');
console.log(`  ${JSON.stringify({ [key]: entry })}\n`);
console.log('多把密钥就是同一个对象里多个键：');
console.log('  {"dgv-trial-aaa":{"dailyCapMinutes":30},"dgv-trial-bbb":{}}\n');
