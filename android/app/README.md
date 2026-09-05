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

**Android has no hot update.** Whatever ships here lives on people's phones
for a long time, including after the Workers it talks to have moved on, so
protocol changes have to stay backward compatible and the native injection
seams are deliberately left in their original shape (see the comments in
`@0xnullai/native`).

## Versioning and app identity

Both Android versions live in **one checked-in file**: `src-tauri/tauri.conf.json`.
0xNuller moves directly to `6.0.0`: the user-facing `version` is `6.0.0`, and
`bundle.android.versionCode` is the aligned monotonic code `6000000`. Tauri
writes both into `gen/android/app/tauri.properties` **at build time**.

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
code all advance together: `v6.3.8`, `0xNuller 6.3.8`, `6.3.8`, and `6003008`.
There is one GitHub Release on that tag; GitHub supplies the source archives and
the workflow attaches the signed APK and Latest badge.

## Prerequisites

- Node.js 22.19+
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
canonical launcher source is `src-tauri/icons/icon.png` and preparation regenerates all densities.

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
  ↓ three seams, each kept in its original shape:
      Agent  servicesOverrides + connectDevice
      Chat   deviceClientFactory + requestDevice
      Voice  transport
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

[`src/lifecycle-safety.ts`](./src/lifecycle-safety.ts) wraps the `TauriBlecDeviceClient` so any backgrounding signal fires `emergencyStop()` before the WebView is suspended. Signals covered:

- `document.visibilitychange` → state becomes `hidden` (Android WebView reliably emits this on host onPause)
- `window.pagehide` (Tauri navigation / app teardown)
- `document.freeze` (Chromium bfcache eviction)
- Tauri `app://paused` event from `lib.rs` on `RunEvent::ExitRequested` (belt-and-braces)

The wrapper is transparent: every method except `disconnect()` forwards unchanged. `disconnect()` additionally detaches the listeners so they don't leak across reconnects.

## Experimental embedded device backend

The APK includes the Buttplug 10.0.3 backend through the
`experimental-buttplug-gate0` Cargo feature. Product use remains default-off behind a separate
local-only setting: a normal launch neither initializes the native session nor scans. The matching
[`ButtplugDeviceBackend`](./src/buttplug-device-backend.ts) is injected once into the unified
shell's shared `@0xnullai/device-runtime`; only an explicit Control scan after opt-in opens it.

The strict v1 IPC surface contains initialize/close, scan start/stop, topology, disconnect,
Vibrate, stop-feature, stop-all, and Battery/RSSI reads. Unknown fields and stale session, topology,
or safety generations are rejected. Device and feature IDs are random and scoped to one native
connection appearance. Only exact `deviceId` + `featureId` Vibrate writes are accepted; native
quantization rounds down to the advertised step count.

Battery and RSSI capabilities are published only when the Buttplug feature declares the `Read`
command. Failed or timed-out reads remain `null`; no value is inferred. Unsupported capabilities,
Raw messages, arbitrary protocol/BLE bytes, addresses, websocket, serial, HID, XInput, automatic
reconnect, output restoration, and name-based brand/capability guesses are not exposed.

Buttplug 10 does not expose safe per-device transport disconnect through its client API. A validated
DeviceRuntime disconnect therefore performs global stop and ends the entire embedded session. This
is intentionally stronger than pretending one BLE link was released or bypassing Buttplug with raw
transport access. The resulting topology is terminal and a new runtime must be explicitly created.

Every structural topology transition advances both native topology and safety generations and
preempts output with global stop before publishing. Telemetry-only refreshes preserve both
fences. Stop-feature and stop-all do not require a current generation fence; an unknown feature stop
falls back to global stop. Stop failures latch the native session, report terminal loss to the
shared runtime, and always retain `hardwareState: "unknown"`.

`ScanCoordinator` is the single ownership seam for the Buttplug and DG plugin scanners. Both paths
claim a generation-scoped lease before scanning, release only after confirmed stop/cleanup, and
retain ownership when scanner state is uncertain. Native Android lifecycle cleanup stops the active
scanner before releasing its lease. The commands remain present in default builds, where they
preserve plugin-blec behavior without compiling the experimental backend.

btleplug 0.12 requires JNI initialization after Tauri loads the Rust library. The Activity also
requests native global stop in `onPause` and `onDestroy`, before WebView timer suspension. The
shared shell safety controller independently stops on lease handoff and browser/Tauri lifecycle
signals. No physical-device or Android lifecycle validation has been performed. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Windows and macOS

The same native host also builds independent Windows x64 and macOS arm64 applications.
Use `npm run desktop:dev` or `npm run desktop:build -- --bundles app` from the repository root.
The desktop overlay is `src-tauri/tauri.desktop.conf.json`; Android identity/configuration remains
unchanged. Desktop identity is `ai.nullai.desktop`. See [desktop.md](../../docs/desktop.md).

Android 8+ remains the OS minimum, but the installed Android System WebView must be version 111+.
Older engines show an upgrade message before the application bootstrap is loaded. Removing CSS
cascade layers is not a promise that Tailwind 4 supports the original Android 8 WebView.
