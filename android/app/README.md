# @0xnullai/android

The shared native host. Android produces **one APK containing all seven modules** — Control, Agent,
Voice, Video, Chat, Playground, Market — not one APK per module.

## Why this exists

Android WebView does not implement Web Bluetooth. So the unified shell
(`apps/web`) is wrapped in a Tauri shell that swaps the device transport for
[`@mnlphlp/plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec) (BLE
through Android's native APIs).

`src/bootstrap.tsx` mounts the same `Shell` component the web build mounts, and
supplies the native pieces through `NativeBridgeProvider` from
`@0xnullai/native`. The shell and every module are shared source, not a
port — `src/styles.css` even `@import`s the shell's own stylesheet, so the
Tailwind `@source` list cannot drift between web and Android.

Before the merge this was three separately packaged APKs (Agent / Chat /
Voice). A user had to install three apps, pair their device in each, and
configure safety limits three times.

**The UI hot-updates; the native layer does not.** Since 7.1.0 every release
also publishes the Android UI as a signed bundle at
`https://0xnullai.com/ota/android/latest.json`. `src-tauri/src/ota.rs` serves the
newest verified bundle through Tauri's own asset protocol (same `tauri.localhost`
origin, so local data stays), takes a new bundle at the next start or on
「立即重启」, and rolls back a bundle that never confirms it rendered
(`src/components/OtaConfirm.tsx`) after three starts. Only manifests signed by the
key in `src-tauri/ota-public-key.txt` and built for the same `NATIVE_API` are
accepted. Anything native — Rust, Kotlin templates, plugins, capabilities,
icons — still needs an APK: bump `NATIVE_API` in `src-tauri/src/ota.rs` and run
`node scripts/native-fingerprint.mjs --write`; CI refuses native changes without
it. Old APKs keep running for a long time, so Worker protocol changes still have
to stay backward compatible.

## Versioning and app identity

Both Android versions live in **one checked-in file**: `src-tauri/tauri.conf.json`.
The user-facing `version` follows the product version (for example `7.3.0`), and
`bundle.android.versionCode` is the aligned monotonic code (`7003000`: major·1000000 +
minor·1000 + patch). 0xNuller started at `6.0.0` / `6000000`, above DG-Agent 5.5.2's
`5005002`. Tauri writes both into `gen/android/app/tauri.properties` **at build time**.

**Bump both before you build, not after.** Building first and bumping second
produces an APK whose internal version is the previous release while the git
tag says the new one — and since the APK is what users install, the tag is
the thing that is wrong. This has happened before.

`identifier` stays `ai.nullai.dgagent` even though the app is now called
0xNuller. Android treats the applicationId as the app's identity: changing it
would make this a _different_ app to the OS, so existing DG-Agent users would
get a second icon instead of an upgrade, with none of their settings, and no
way to migrate the data. The name is cosmetic; the identifier is not.

The GitHub source/product tag, release title, APK `versionName`, and internal
code all advance together: `v7.3.0`, `猫愿 7.3.0`, `7.3.0`, and `7003000`.
There is one GitHub Release on that tag; GitHub supplies the source archives and
the workflow attaches the signed `maoyuan-vX.Y.Z.apk` and Latest badge.

## Prerequisites

- Node.js 26+
- Rust 1.88+ with Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Android SDK with platform 34/35/36 + build-tools 34/35
- Android NDK 26.x (set `NDK_HOME` or `ANDROID_NDK_HOME`)
- `cargo install tauri-cli --version "^2"`
- Java 17+

Set environment:

```bash
export ANDROID_HOME=$HOME/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
```

## First-time setup

```bash
npm run android:init      # regenerates src-tauri/gen/android/, then prepares it
```

The `gen/android/` directory is regenerated and gitignored. `npm run android:prepare`
deterministically applies [`AndroidManifest.template.xml`](./AndroidManifest.template.xml),
sets minSdk 26, injects [`signing.gradle.kts.template`](./signing.gradle.kts.template), and
restores [`MainActivity.template.kt`](./MainActivity.template.kt). The activity applies system-bar
and display-cutout insets at the native WebView boundary, including on older WebView versions whose
CSS safe-area variables do not expose three-button navigation insets. Preparation also resolves the
Cargo.lock-selected btleplug 0.12 package, copies its JNI-only Java sources into the generated
project, and restores the required R8 keep rules. Those generated sources remain untracked.
Both root Android commands run it automatically; do not invoke the workspace command directly
for a release.

Two things that cost a build cycle if you script step 1:

- **The template's own comment contains the string `<manifest>`** (it says to
  paste into the `<manifest>` root). Strip comments before locating the tag,
  or you'll splice half the comment into the XML. Gradle then fails with
  `ManifestMerger2$MergeFailureException: Error parsing …AndroidManifest.xml`
  — which says nothing about what actually went wrong.
- **`cargo tauri android init` does not overwrite an existing
  AndroidManifest.xml.** A broken one survives re-init; delete the file first.

Validate before building: `python3 -c "import xml.dom.minidom as m;
m.parse('src-tauri/gen/android/app/src/main/AndroidManifest.xml')"` — two
seconds, versus a two-minute Gradle run that reports the wrong cause.

## Release builds

`gen/android/` is regenerated from scratch and gitignored. The checked-in preparation script
re-applies the 0xNuller launcher icons, release signing, and native compatibility settings. It
fails a release Gradle task when any signing variable is absent; an unsigned APK can no longer
look like a successful release build. Do not edit generated `mipmap-*` resources directly: the
canonical launcher source is `brand/icon/manifest.json` (adaptive foreground `fg.png`, background
`#080808`, Android 13 themed-icon `mono.png`), and preparation regenerates all densities plus the
adaptive round icon. Each PNG there is rendered from the SVG beside it.

To produce an installable release APK, load these environment variables before building
(keystore path + passwords are kept outside the repo, mode 600, and never committed):

```bash
set -a
source ~/.dg-keystores/passwords.txt
set +a
npm run android:build -- --apk --target aarch64
```

Without these set, `signingConfigs.release` has no `storeFile`, and Gradle
either fails on the release build type or (for `debug`) it doesn't matter —
debug builds always use the Android debug key regardless.

## Develop

```bash
npm run android:dev   # tauri android dev — installs on a connected device
```

## Notifications

There is no system push. Most users' phones have no Google services, so FCM was removed: the APK
has no Firebase dependency or push service. New messages show as in-app unread counts. The only
notification is local: since native API 3 the APK asks for `POST_NOTIFICATIONS` solely for the
ongoing 「设备输出中」 notification of the background keep service (one low-importance channel,
「设备输出」; see Lifecycle safety), and only when the user picks a background keep duration. Android builds released before the removal may still call
`/api/auth/push/registrations`; Auth answers 410 (register) or 404 (revoke), which those builds
handle without retrying. `android:prepare` also strips the old Firebase service, resources, manifest
entries, and Gradle dependencies from a reused generated project.

## Build APK

```bash
npm run android:build -- --apk
# APK at src-tauri/gen/android/app/build/outputs/apk/universal/{debug,release}/
```

## Architecture

```
Shell (@0xnullai/web) + seven modules, reused via vite alias
  ↓
NativeBridgeProvider (@0xnullai/native) — the one injection point
  ↓ dglab: one DgLabConnectionRegistry for every module
  ↓   (Agent also gets non-device flags: no speech or update check)
createTauriDgLabTransport — one shared chooser (requestDeviceTauri)
  ↓
wrapWithLifecycleSafety  ← Android safety net (see below)
  ↓
TauriBlec{Device,Opossum,PawPrints,CivetEdging}Client (@dg-kit/transport-tauri-blec)
  ↓ scan + connect + (uuid, bytes) writes
@mnlphlp/plugin-blec (Tauri plugin, pinned to the 0xNullAI multi-connection fork)
  ↓ JNI
android.bluetooth.le.* (Android system BLE)
  ↓
DG-Lab Coyote 2.0 / 3.0 · paw-prints · civet-edging · Opossum
```

The vite aliases in `vite.config.ts` (`@agent` / `@voice` / `@chat` /
`@control`) **must stay identical to `apps/web/vite.config.ts`**. They differ
per module because before the merge every module used a bare `@`, which
collides once they are packed into one build.

### Lifecycle safety

Coyote V3 is state-retentive: once a strength is commanded, the device keeps running until a new packet arrives — _not_ until the BLE link drops. On a normal browser tab this is invisible because the page's `setInterval` keeps ticking out new packets (throttled but alive) even when backgrounded.

Android Tauri is different: when the user swipes home / locks the screen, the host activity hits `onPause` and the WebView is suspended. JS timers stop. The device keeps running at the last commanded strength until the BLE link eventually drops, which can take a long time.

[`src/lifecycle-safety.ts`](./src/lifecycle-safety.ts) wraps the `TauriBlecDeviceClient` so any backgrounding signal fires `emergencyStop()` before the WebView is suspended — unless the user's background keep holds output (below). Signals covered:

- `document.visibilitychange` → state becomes `hidden` (Android WebView reliably emits this on host onPause)
- `window.pagehide` (Tauri navigation / app teardown)
- `document.freeze` (Chromium bfcache eviction)
- Tauri `app://paused` event from `lib.rs`, emitted only on `RunEvent::ExitRequested` (app exit, not onPause)

The wrapper is transparent: every method except `disconnect()` forwards unchanged. `disconnect()` additionally detaches the listeners so they don't leak across reconnects.

None of those JS paths survive a frozen or killed page, so the native layer keeps its own floor:

- **Device-side cap.** The registry writes each Coyote's effective limit into the device (BF soft limit) on connect, on reconnect and on every limit change, so the device refuses higher strength even from its own wheel or with no app running.
- **Native stop.** After connecting, `@dg-kit/transport-tauri-blec` registers the device's stop packet (bytes from the protocol adapter) with plugin-blec (`set_safety_stop`). `MainActivity.onPause` (unless a background keep holds output, below) and `onDestroy` then make the plugin write it for every device ahead of any queued write, without waiting for the page. `emergencyStop()` uses the same preemptive write first.
- **Write watchdog.** The tick writes every 100 ms while output runs; if no write reaches a device for 1.5 s, the plugin writes its stop packet once.

A process the system kills outright gets no callback; the device-side cap is what still applies then.

#### Background keep (native API 3)

「设备与安全 → 切到后台时」 offers 5 or 10 minutes on Android (the web offers 5/10/30). Keeping is
fail-closed: unless **every** precondition holds at `onPause`, the behaviour above applies unchanged.

- **Preconditions.** The APK has the keep bridge (`AndroidSystem.getBackgroundKeepCapability() ≥ 1`),
  notifications are allowed (`POST_NOTIFICATIONS` on Android 13+, app notifications and the
  「设备输出」 channel on), the user chose 5 or 10 minutes, some Coyote/Opossum output is nonzero, the
  `connectedDevice` foreground service `DeviceOutputService` is already running (it is only ever
  started while the activity is in the foreground, never at `onPause`), and a partial wake lock for
  the kept minutes was acquired. Choosing a duration without the permission asks for it; a refusal
  stores 「立即停止」.
- **Who decides.** The page reports its state through `AndroidSystem.setBackgroundKeep(enabled, keepMs,
outputActive)` whenever the setting, the permission or "any output active" changes
  (`installAndroidBackgroundKeep` in `@0xnullai/native`). `MainActivity.onPause` alone decides and
  records the deadline before telling the page (`0xnullai:native-pause` with `{kept, until, at}`). The
  page's `backgroundKeepMs()` reads that same record (`getBackgroundKeepUntil()`), so the shell's
  hold, every module guard and both lifecycle wrappers reach one answer. If the pause event and the
  shared answer ever disagree, the page stops and disarms the service, which then stops natively.
- **While kept.** Scanning still stops. The notification reads 「后台保持中 · 剩余 mm:ss」 with
  「急停」; the registry admits only commands that stop or lower output; Agent pauses its AI work.
- **What still stops.** The native deadline (a main-thread tick against elapsed real time), 急停,
  removing the task, an unplanned service destroy and `Activity.onDestroy` all stop output natively
  through the dedicated JNI entry `NativeOutputSafety.requestNativeOutputStop` → Rust
  `request_native_output_stop()` (plugin-blec `safety_stop_all()`), without the WebView, and then
  dispatch `0xnullai:native-output-stopped` (`{reason, at}`); the page records it as
  `background-timeout` (deadline) or `background` (everything else). `pagehide`, `freeze` and the Tauri
  exit event always stop. Returning to the app cancels the deadline. The 1.5 s write watchdog stays:
  if the throttled page stops ticking, the plugin stops the device.

## BLE scanner ownership

`ScanCoordinator` (`src-tauri/src/scan_coordinator.rs`) gives plugin-blec scans exclusive ownership of
Android's single scanner callback. Each scan claims a generation-scoped lease through
`dg_blec_claim_scanner`, releases it through `dg_blec_release_scanner` only after confirmed
stop/cleanup, and retains it when scanner state is uncertain. `MainActivity.onPause`/`onDestroy` call
`requestNativeLifecycleSafety`, which stops the active scan before releasing its lease, kept or not.
Output stops have their own JNI entry (`requestNativeOutputStop`, see Lifecycle safety).

## WebView requirements

Only Android is built from this host; Windows and macOS installers are no longer shipped.

Android 8+ remains the OS minimum, but the installed Android System WebView must be version 111+.
Older engines show an upgrade message before the application bootstrap is loaded. Removing CSS
cascade layers is not a promise that Tailwind 4 supports the original Android 8 WebView.
