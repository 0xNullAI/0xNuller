# @dg-chat/tauri-android

Tauri 2 Android shell for DG-Chat.

## Why this exists

Android WebView does not implement Web Bluetooth. We wrap the existing
React app in a Tauri shell and swap the device transport for
[`@mnlphlp/plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec)
(BLE via Android native APIs).

The web app under `../../src` is reused verbatim — `App.tsx` accepts an
optional `deviceClientFactory` prop, and this shell passes a factory
that builds a `TauriBlecDeviceClient` from `@dg-kit/transport-tauri-blec`.

## Important: PeerJS / WebRTC unverified on Android

DG-Chat's P2P chat / remote-device-control layer is built on PeerJS
(WebRTC under the hood). Android WebView claims to support WebRTC since
API 26 but the practical reality with Tauri-bundled WebViews on
arbitrary device firmware is unverified. **Smoke test on a real device
before promising any release** — see "Known risks" below.

## Prerequisites

- Rust 1.78+ with Android targets:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```
- Android SDK with platform 34/35/36 + build-tools 34/35
- Android NDK 26.x (set `NDK_HOME` or `ANDROID_NDK_HOME`)
- `cargo install tauri-cli --version "^2"`
- Java 17+

```bash
export ANDROID_HOME=$HOME/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
```

## First-time setup

```bash
cd apps/tauri-android
cargo tauri android init      # regenerates src-tauri/gen/android/
# After init, re-apply BLE permissions to AndroidManifest.xml — see below.
```

The `gen/android/` directory is regenerated and gitignored. After every
regeneration:

1. Copy the `<uses-permission>` / `<uses-feature>` block from
   [`AndroidManifest.template.xml`](./AndroidManifest.template.xml) into
   `gen/android/app/src/main/AndroidManifest.xml` (inside `<manifest>`
   root, before `<application>`). The template explains each permission.
2. Bump `gen/android/app/build.gradle.kts` `minSdk` to `26` (required by
   `@mnlphlp/plugin-blec`'s Android backend).
3. Re-apply the release-signing config from
   [`signing.gradle.kts.template`](./signing.gradle.kts.template) into
   `gen/android/app/build.gradle.kts` — see "Release builds" below for why
   this is needed and what it reads.

## Release builds

`gen/android/` is regenerated from scratch by `cargo tauri android init` and
is gitignored, so the release-signing config isn't checked in anywhere — it
has to be re-applied by hand after every regeneration (step 3 above), reading
from [`signing.gradle.kts.template`](./signing.gradle.kts.template).

To produce an installable release APK, set these environment variables
before building (keystore path + passwords are kept outside the repo, not
committed anywhere):

```bash
export DG_CHAT_KEYSTORE=/path/to/dg-chat-release.jks
export DG_CHAT_ALIAS=dg-chat
export DG_CHAT_STORE_PASS=...
export DG_CHAT_KEY_PASS=...
npm run tauri:android:build -- --apk --target aarch64
```

Without these set, `signingConfigs.release` has no `storeFile`, and Gradle
either fails on the release build type or (for `debug`) it doesn't matter —
debug builds always use the Android debug key regardless.

## Develop

```bash
# from repo root
npm run tauri:android:dev    # tauri android dev — installs on a connected device
```

## Build APK

```bash
npm run tauri:android:build -- --apk
# APK at apps/tauri-android/src-tauri/gen/android/app/build/outputs/apk/universal/{debug,release}/
```

## Architecture

```
React UI (../../src/App.tsx, reused via @chat/* path alias)
  ↓
useDevice({ clientFactory })   ← injected per-runtime
  ↓
DGLabDevice (../../src/lib/bluetooth.ts) — protocol facade
  ↓
wrapWithLifecycleSafety  ← Android safety net (see below)
  ↓
TauriBlecDeviceClient (@dg-kit/transport-tauri-blec)
  ↓ scan + connect + (uuid, bytes) writes
@mnlphlp/plugin-blec (Tauri plugin)
  ↓ JNI
android.bluetooth.le.* (Android system BLE)
  ↓
DG-Lab Coyote 2.0 / 3.0
```

### Lifecycle safety (mobile-specific)

Coyote V3 is state-retentive: once a strength is commanded, the device
keeps running until a new packet arrives — *not* until the BLE link
drops. On a normal browser tab this is invisible because the page's
`setInterval` keeps ticking out new packets (throttled but alive) even
when backgrounded. The web build of DG-Chat already has a
`visibilitychange` handler in `useDevice` that respects the user's
**Background behavior** setting (stop vs keep).

Android Tauri is different. When the user swipes home / locks the
screen, the host activity hits `onPause` and the WebView is suspended.
JS timers stop. The device keeps running at the last commanded strength
until the BLE link eventually drops.

[`src/lifecycle-safety.ts`](./src/lifecycle-safety.ts) wraps the
`TauriBlecDeviceClient` so any backgrounding signal fires
`emergencyStop()` *unconditionally* — overriding the user's "keep" mode.
The reasoning: "keep" on a phone is too risky because the OS may kill
the WebView. Users who genuinely need keep-running on Android should
use a Foreground Service (future work).

Signals covered:

- `document.visibilitychange` → state becomes `hidden` (Android WebView
  reliably emits this on host onPause)
- `window.pagehide` (Tauri navigation / app teardown)
- `document.freeze` (Chromium bfcache eviction)
- Tauri `app://paused` event from `lib.rs` on `RunEvent::ExitRequested`
  (belt-and-braces)

## Known risks (test before promising a release)

| Risk | What to verify | Workaround |
|---|---|---|
| **WebRTC / PeerJS on Tauri Android** | Create a 2-device room, send a chat message, attempt remote-control of one device. Check the PeerJS broker connects and the data channel opens. | If WebRTC fails: bundle a STUN/TURN config in `usePeerRoom`, or fall back to MQTT relay (already supported). |
| **`@dg-kit/transport-tauri-blec` 1.1.0 missing emergencyStop-on-disconnect** | `disconnect()` doesn't zero the device before tearing down BLE. | Will be fixed in `@dg-kit/*` 1.2.0; until then the lifecycle-safety wrapper compensates by firing emergencyStop on pagehide. |
| **plugin-blec service discovery timing** | `getPrimaryService` after `connect` may race. | Real-device test only. If flaky, add a 200ms delay after connect or use plugin-blec's explicit discover_services if exposed. |
| **MTU under 23** | Coyote write packets are ≤20 bytes; some Android devices default to MTU 20. | If writes fail with timeout, request larger MTU in plugin-blec (not exposed in 0.8 — would need plugin update). |
