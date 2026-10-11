/* global document */
// Headless smoke test of the local stack (docs/testing.md 本地联调) with the system Chromium.
//
//   node scripts/dev/e2e-smoke.mjs                 # signed-out checks
//   E2E_USER=tester_a E2E_PASS=… node scripts/dev/e2e-smoke.mjs   # also signs in
//
// E2E_BASE (default http://localhost:8790) and CHROMIUM (default /usr/bin/chromium) override.
import { chromium } from 'playwright-core';

const base = process.env.E2E_BASE ?? 'http://localhost:8790';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
});
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  check((await page.title()) === '猫愿', 'title is 猫愿');
  check(
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
    'opens in dark mode',
  );
  await page.getByRole('button', { name: '登录' }).last().waitFor();
  check(true, 'sign-in card renders');

  if (process.env.E2E_USER && process.env.E2E_PASS) {
    await page.getByPlaceholder('3–24 位字母、数字、下划线').fill(process.env.E2E_USER);
    await page.getByPlaceholder('输入密码').fill(process.env.E2E_PASS);
    await page.getByRole('button', { name: '登录' }).last().click();
    await page.getByRole('button', { name: '新聊天' }).waitFor({ timeout: 15_000 });
    check(true, 'signs in and shows the inbox');
    await page.getByRole('button', { name: '新聊天' }).click();
    const items = await page.getByRole('menuitem').allTextContents();
    check(
      items.includes('找联系人聊天') && items.includes('创建群聊'),
      `new-chat menu: ${items.join(' / ')}`,
    );
    await page.keyboard.press('Escape');
    await page.goto(`${base}/settings/overview`, { waitUntil: 'networkidle' });
    const rows = await page.locator('section[aria-label="设置"] button').allTextContents();
    check(!rows.some((row) => row.includes('聊天设置')), '我的 does not list 聊天设置');
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
