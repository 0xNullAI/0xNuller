# 安卓发版

四个模块打进一个 APK。构建步骤在 [`android/app/README.md`](../android/app/README.md)，
这里只写**发版本身**——那些做错了就没法补救的部分。

## 三个不能动的东西

### 1. 签名密钥必须是 `dg-agent-release.jks`

`tauri.conf.json` 的 `identifier` 保留为 `ai.nullai.dgagent`。这是刻意的：老用户装的
DG-Agent 会把这个 APK 认成**原地升级**，不用卸载重装，数据也不丢。

代价是签名密钥被锁死了。安卓拒绝安装签名不一致的同 applicationId 应用，报错只有一句
「应用未安装」，不会说明原因。换了密钥就等于把所有存量用户挡在门外，而且**没有补救
办法**——只能改 identifier 重新做一个 app，那些用户还是升不了。

```bash
export DG_AGENT_KEYSTORE=~/.dg-keystores/dg-agent-release.jks
```

`dg-voice-release.jks` 和 `dg-chat-release.jks` 对应的是各自独立的 applicationId，
统一之后不再使用。**不要因为「现在叫 0xNuller 了」就去建一个新密钥。**

### 2. 版本号接着 DG-Agent 的线走

`tauri.conf.json` 现在是 `5.5.2`，不是 `0.1.0`。安卓的 `versionCode` 只能递增，
而存量用户手机上装的是 DG-Agent 的 5.x——降到 0.x 会让升级被系统直接拒绝。

平台仓库根 `package.json` 的版本（网页那条线）和这个是两回事，各走各的。

### 3. Release tag 必须是 `android-v<版本号>`

应用内的更新提示按这个前缀在 `/releases` 里找 APK。合并之后同一个仓库还会打出
`@dg-kit/core@1.14.0`（changesets）和 `v0.2.0`（平台版本）这类 tag，用
`releases/latest` 拿到的多半不是 APK——**更新提示会静默失效**，用户不会收到任何
出错信号，就一直留在旧版本上。安卓没有热更新，这件事只能靠重新打包来修。

对应实现与测试在 `android/app/src/services/update-checker.ts`。

## 顺序

**从 `main` 的实际 tip 构建，在版本号提交合并之后。**

`dev` 上永远没有版本号提交——它只随发布 PR 进 `main`。从 `dev` 构建出来的 APK 里烤
的是**上一个版本**的 versionName/versionCode，然后被挂到新的 Release tag 上，两边对
不上。这个错误犯过一次，是上传之后用 `aapt dump badging` 才发现的。

```bash
git checkout main && git pull

# gen/android 是 gitignore 的，每次 `tauri android init` 都从头生成，
# 会丢掉签名配置、BLE 权限和 minSdk——按 android/app/README.md 的三步重新贴回去。

npm run build:kit && npm run build
export DG_AGENT_KEYSTORE=~/.dg-keystores/dg-agent-release.jks
export DG_AGENT_ALIAS=dg-agent
export DG_AGENT_STORE_PASS=...   # 见 ~/.dg-keystores/passwords.txt
export DG_AGENT_KEY_PASS=...
npm run android:build -w @0xnullai/android -- --apk --target aarch64
```

## 上传前必须验的两件事

`aapt` 和 `apksigner` 在 Android SDK 的 build-tools 里，默认不在 PATH 上：

```bash
export PATH="$HOME/Library/Android/sdk/build-tools/35.0.0:$PATH"
APK=$(ls android/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk)

# 版本号真的是这一版吗——从 dev 构建的话这里会是上一个版本
aapt dump badging "$APK" | grep -E "versionName|versionCode"

# 签名是不是那把对的钥匙——没设环境变量时 Gradle 会产出未签名产物而不报错
apksigner verify --print-certs "$APK" | grep -E "CN=|OU="
```

正确的输出长这样（2026-08-08 实测）：

```
package: name='ai.nullai.dgagent' versionCode='5005002' versionName='5.5.2'
application-label:'0xNuller'
Signer #1 certificate DN: CN=DG-Agent, OU=0xNullAI, O=0xNullAI, …
```

三处各自的含义：`name` 决定能不能覆盖安装到老用户手机上；`application-label` 是
桌面上显示的名字（已经是 0xNuller）；`CN=DG-Agent` 是证书主题，**它就该是这个**
——换掉等于换密钥。APK 约 15MB。

签名那一条尤其要看：`signingConfigs` 里有 `if (ks != null)` 的保护，环境变量没设时
构建**照样成功**，只是出来的 APK 装不上。

然后：

```bash
gh release create "android-v5.5.3" --repo 0xNullAI/0xNuller \
  --title "安卓 5.5.3" --notes "..." "$APK"
```

## 发布之后

APK 装到真机上，确认这几件——它们都只有真设备能验：

- **蓝牙**：连上郊狼，四种设备都试一遍（郊狼 / 负鼠 / 爪印 / 灵猫）
- **锁屏**：正在输出时锁屏，设备必须停下。WebView 被挂起后定时器全停，而郊狼是
  状态保持的——漏了这个，设备会一直输出到用户回到应用或者蓝牙自己掉线
- **登录**与**体验版语音**：两者的 origin 白名单都要含 `http://tauri.localhost`，
  漏了的话界面只显示「连接失败」
- **更新提示**：把 `tauri.conf.json` 的版本临时调低重新装一个，看提示是否出现且
  指向正确的 release 页
