import { existsSync, readFileSync, readdirSync } from 'node:fs';

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

// generate_context! takes the default window icon from the bundle PNG; Android
// launcher icons are generated from brand/icon by prepare-android-release.mjs.
for (const icon of ['icon.png']) {
  const path = `android/app/src-tauri/icons/${icon}`;
  if (!existsSync(path)) fail(`${path} is missing`);
}

// tauri::generate_context! refuses any bundled PNG that is not 8-bit RGBA, and
// image optimisers silently turn opaque or small icons into palette PNGs.
for (const path of readdirSync('android/app/src-tauri/icons', { recursive: true })
  .filter((name) => String(name).endsWith('.png'))
  .map((name) => `android/app/src-tauri/icons/${name}`)) {
  const header = readFileSync(path).subarray(0, 26);
  if (header.readUInt8(24) !== 8 || header.readUInt8(25) !== 6) {
    fail(`${path} must be an 8-bit RGBA PNG`);
  }
}

console.log('brand assets are aligned across standalone apps, unified web, and Android');
