import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const generated = join(root, 'android/app/src-tauri/gen/android/app');
const gradlePath = join(generated, 'build.gradle.kts');
const manifestPath = join(generated, 'src/main/AndroidManifest.xml');
const signingTemplatePath = join(root, 'android/app/signing.gradle.kts.template');
const manifestTemplatePath = join(root, 'android/app/AndroidManifest.template.xml');

for (const path of [gradlePath, manifestPath]) {
  if (!existsSync(path)) {
    throw new Error(`missing generated Android project; run npm run android:init first (${path})`);
  }
}

function attribute(node, name) {
  return node.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? null;
}

function kotlinBlocks(source, name) {
  const blocks = [];
  const pattern = new RegExp(`\\b${name}\\s*\\{`, 'g');
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        blocks.push({ start, end: index + 1, text: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return blocks;
}

let manifest = readFileSync(manifestPath, 'utf8');
const manifestTemplate = readFileSync(manifestTemplatePath, 'utf8');
const requiredNodes = manifestTemplate.match(/<uses-(?:permission|feature)\b[\s\S]*?\/>/g) ?? [];
const missingNodes = requiredNodes.filter((node) => {
  const androidName = attribute(node, 'android:name');
  return androidName && !manifest.includes(`android:name="${androidName}"`);
});
if (missingNodes.length > 0) {
  const insertion = missingNodes.map((node) => `    ${node.replace(/\n\s*/g, ' ')}`).join('\n');
  manifest = manifest.replace(/\n\s*<application\b/, `\n\n${insertion}\n\n    <application`);
  writeFileSync(manifestPath, manifest);
}

let gradle = readFileSync(gradlePath, 'utf8');
if (!/\bminSdk\s*=\s*\d+/.test(gradle)) throw new Error('generated Gradle file has no minSdk');
gradle = gradle.replace(/\bminSdk\s*=\s*\d+/, 'minSdk = 26');

const signingTemplate = readFileSync(signingTemplatePath, 'utf8').trimEnd();
const signingMarker = '// 0XNULLER_RELEASE_SIGNING';
const releaseSigningBlocks = kotlinBlocks(gradle, 'signingConfigs').filter((block) =>
  block.text.includes('create("release")'),
);
const hardenedSigningBlock = releaseSigningBlocks.find((block) =>
  gradle
    .slice(Math.max(0, block.start - signingMarker.length - 80), block.start)
    .includes(signingMarker),
);
if (hardenedSigningBlock) {
  for (const block of releaseSigningBlocks.toReversed()) {
    if (block.start !== hardenedSigningBlock.start) {
      gradle = `${gradle.slice(0, block.start)}${gradle.slice(block.end)}`;
    }
  }
} else if (releaseSigningBlocks.length > 0) {
  const [first, ...duplicates] = releaseSigningBlocks;
  for (const block of duplicates.toReversed()) {
    gradle = `${gradle.slice(0, block.start)}${gradle.slice(block.end)}`;
  }
  gradle = `${gradle.slice(0, first.start)}${signingTemplate}${gradle.slice(first.end)}`;
} else {
  gradle = gradle.replace(/^(\s*)buildTypes\s*\{/m, `${signingTemplate}\n\n$1buildTypes {`);
}
const releaseBlock = /(getByName\("release"\)\s*\{\n)(?!\s*signingConfig)/;
if (!gradle.includes('signingConfig = signingConfigs.getByName("release")')) {
  if (!releaseBlock.test(gradle))
    throw new Error('generated Gradle file has no release build type');
  gradle = gradle.replace(
    releaseBlock,
    '$1            signingConfig = signingConfigs.getByName("release")\n',
  );
}
const normalizedReleaseSigningBlocks = kotlinBlocks(gradle, 'signingConfigs').filter((block) =>
  block.text.includes('create("release")'),
);
if (normalizedReleaseSigningBlocks.length !== 1) {
  throw new Error('generated Gradle file must contain exactly one release signing config');
}
writeFileSync(gradlePath, gradle);

for (const required of [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.hardware.bluetooth_le',
]) {
  if (!manifest.includes(required)) throw new Error(`Android manifest is missing ${required}`);
}
if (!gradle.includes('minSdk = 26') || !gradle.includes(signingMarker)) {
  throw new Error('generated Android Gradle configuration is incomplete');
}

console.log('Android project prepared: BLE permissions, minSdk 26, fail-closed release signing');
