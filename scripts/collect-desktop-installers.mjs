import { readdirSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error('Usage: collect-desktop-installers <source> <destination>');
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  );
}
const all = files(source);
mkdirSync(destination, { recursive: true });
for (const [suffix, platform] of [
  ['.dmg', 'macos-universal'],
  ['.exe', 'windows-x64'],
]) {
  const matches = all.filter((file) => file.endsWith(suffix));
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${platform} installer, found ${matches.length}`);
  copyFileSync(matches[0], path.join(destination, `0xnuller-v${version}-${platform}${suffix}`));
}
