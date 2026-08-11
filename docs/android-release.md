# 安卓发版

六个模块打进一个 APK。构建步骤在 [`android/app/README.md`](../android/app/README.md)，
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

### 2. 0xNuller 直接进入 6.0.0

0xNuller 继承 DG-Agent 的 Android 更新身份，并直接推进一个大版本。
`tauri.conf.json` 中对用户显示的 `version` 是 `6.0.0`，Android 内部的
`bundle.android.versionCode` 是 `6000000`。两者和 GitHub Release tag 始终对齐。

存量 DG-Agent 5.5.2 的内部代码是 `5005002`，所以 `6000000` 能被 Android 识别为
原地升级，不需要为重置版本号引入额外映射层。

### 3. Release tag 必须是 `android-v<版本号>`

应用内的更新提示按这个前缀在 `/releases` 里找 APK。第一个 0xNuller 发布使用
当前发布使用 tag `android-v6.0.4`，Release 标题和 APK 也都显示 `0xNuller 6.0.4`。

合并之后同一个仓库还会打出
`@dg-kit/core@1.14.0`（changesets）和 `v6.0.0`（平台版本）这类 tag，用
`releases/latest` 拿到的多半不是 APK——**更新提示会静默失效**，用户不会收到任何
出错信号，就一直留在旧版本上。安卓没有热更新，这件事只能靠重新打包来修。

对应实现与测试在 `android/app/src/services/update-checker.ts`。

## 顺序

**从 `main` 的实际 tip 构建，在版本号提交合并之后。**

`dev` 可以提前包含下一版版本号，但它之后还可能继续变化；发布产物必须来自最终合入
`main` 的同一个 commit，不能拿较早的 dev 构建挂到 Release tag。脚本会检查 npm、Cargo、
Tauri 与 Android versionCode 是否一致，上传前仍要检查 APK 内部元数据。

```bash
git checkout main && git pull

npm run build:kit && npm run build
# passwords.txt 是只含上述四个 DG_AGENT_* 赋值的 shell 文件；不要打开后复制到日志。
chmod 600 ~/.dg-keystores/passwords.txt ~/.dg-keystores/dg-agent-release.jks
set -a
source ~/.dg-keystores/passwords.txt
set +a
npm run android:build -- --apk --target aarch64
```

## 上传前必须验的产物

自动门禁会从 Android SDK 中选择最新的 build-tools，同时核对包名、版本、versionCode、
应用名、minSdk、arm64 ABI、BLE/旧版定位权限、APK v2 签名、旧 DG-Agent 证书指纹，以及
APK 内嵌的源码 commit 是否等于当前 Git HEAD。release 构建只接受干净工作树：

```bash
APK=$(ls android/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk)
npm run verify:android:apk -- "$APK"
```

正确的输出会包含这些字段：

```json
{
  "package": "ai.nullai.dgagent",
  "versionName": "6.0.0",
  "versionCode": 6000000,
  "label": "0xNuller",
  "sourceCommit": "<当前 Git HEAD>"
}
```

`package` 决定能不能覆盖安装到老用户手机上；`label` 是桌面上显示的名字（已经是
0xNuller）；证书 SHA-256 必须匹配旧 DG-Agent；`sourceCommit` 证明 APK 确实来自准备发布的
提交，而不是同版本号的旧候选。APK 约 15MB。

签名配置是 fail-closed：release 任务缺任一 `DG_AGENT_*` 变量都会直接失败，不能产出
未签名候选。自动门禁仍必须执行，因为变量也可能指向错误的 keystore 或版本产物。

然后：

```bash
gh release create "android-v6.0.4" --repo 0xNullAI/0xNuller \
  --title "0xNuller 6.0.4" --notes-file docs/releases/6.0.4.md "$APK"
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
