import { existsSync, readFileSync } from 'node:fs';

const variants = {
  light: 'brand/logo/0xnuller-light.svg',
  dark: 'brand/logo/0xnuller-dark.svg',
};
const apps = ['web', 'agent', 'chat', 'voice', 'market'];

function fail(message) {
  throw new Error(message);
}

for (const [variant, source] of Object.entries(variants)) {
  const canonical = readFileSync(source, 'utf8').trim();
  for (const app of apps) {
    const target = `apps/${app}/public/favicon-${variant}.svg`;
    if (!existsSync(target)) fail(`${target} is missing`);
    if (readFileSync(target, 'utf8').trim() !== canonical) {
      fail(`${target} drifted from ${source}`);
    }
  }
}

for (const app of apps) {
  const html = readFileSync(`apps/${app}/index.html`, 'utf8');
  for (const variant of Object.keys(variants)) {
    if (!html.includes(`/favicon-${variant}.svg`)) {
      fail(`apps/${app}/index.html does not reference the ${variant} logo`);
    }
  }
}

for (const icon of ['32x32.png', '128x128.png', 'icon.png', 'icon.ico']) {
  const path = `android/app/src-tauri/icons/${icon}`;
  if (!existsSync(path)) fail(`${path} is missing`);
}

console.log('brand assets are aligned across standalone apps, unified web, and Android');
