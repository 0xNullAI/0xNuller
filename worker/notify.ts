// Emails the day's 体验版 activation key via Cloudflare's native Email Sending
// binding (no API key, no third-party service). The sender domain must be
// onboarded once: `wrangler email sending enable 0xnullai.com`.
//
// The recipient (`TRIAL_KEY_EMAIL_TO`) is a SECRET, not a var — it's a personal
// address and this repo is public, so it must never land in wrangler.jsonc.
import type { Env } from './env.js';

export async function emailDailyKey(env: Env, key: string, date: string): Promise<void> {
  const to = env.TRIAL_KEY_EMAIL_TO?.trim();
  if (!to) return; // recipient not configured → skip silently
  const from = env.TRIAL_KEY_EMAIL_FROM?.trim() || 'trial@0xnullai.com';

  const subject = `DG-Voice 体验版今日密钥（AOE ${date}）`;
  const lines = [
    `今日（AOE ${date}）的体验版激活密钥：`,
    '',
    `    ${key}`,
    '',
    '在 voice.0xnullai.com 选「体验版」，把它填进「激活密钥」框即可。',
    '下一个 AOE 日（每天 12:00 UTC）自动轮换，本邮件会再发新的一把。',
  ];
  const html =
    `<p>今日（AOE ${date}）的体验版激活密钥：</p>` +
    `<p style="font-family:monospace;font-size:16px;font-weight:700">${key}</p>` +
    `<p>在 <a href="https://voice.0xnullai.com">voice.0xnullai.com</a> 选「体验版」，` +
    `把它填进「激活密钥」框即可。</p>` +
    `<p>下一个 AOE 日（每天 12:00 UTC）自动轮换，本邮件会再发新的一把。</p>`;

  await env.EMAIL.send({
    to,
    from: { email: from, name: 'DG-Voice' },
    subject,
    text: lines.join('\n'),
    html,
  });
}
