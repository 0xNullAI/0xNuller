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
if (!gradle.includes(signingMarker)) {
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
