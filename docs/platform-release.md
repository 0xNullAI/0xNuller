# 0xNuller 发布体系

仓库有三条独立版本线、多类交付物。所有生产发布都只从通过对应 CI 的 `main` commit
执行；`dev` 只用于开发、集成、版本准备和测试。

| 发布线   | 交付物              | 版本来源                   | 发布位置                    |
| -------- | ------------------- | -------------------------- | --------------------------- |
| 0xNuller | Web + Android APK   | 根 `package.json`          | Cloudflare + GitHub Release |
| DG-Kit   | 7 个 `@dg-kit/*` 包 | Kit 固定 Changesets 版本组 | npm                         |
| DG-MCP   | `dg-mcp`            | `apps/mcp/package.json`    | npm                         |

DG-Kit 和 DG-MCP 不创建 GitHub tag 或 Release。GitHub Releases 页面只展示 0xNuller 产品。

## 分支职责

- 维护者可把已验证提交直接推到 `dev`；需要评审时，功能分支从 `dev` 创建并合并回 `dev`。
- `dev` 不受分支保护，可以包含 changeset、下一产品版本和发布说明，但不能部署或发布任何产物。
- `main` 是唯一生产源，只接受 `dev → main` 发布 PR，并使用 merge commit。
- 手动发布同样校验目标 SHA 等于当前 `main` HEAD，不能选择其他分支绕过。

## 0xNuller 产品发布

Windows/macOS 安装器不再构建或发布。Web 与 Android 是同一个产品版本，必须来自同一个
`main` commit：

```text
根 package:             7.1.5
Web version.json:       7.1.5 + main commit SHA
Android 热更新包:        https://0xnullai.com/ota/android/latest.json（7.1.5 + main commit SHA）
Android versionName:    7.1.0（仅 APK 发布）
Android versionCode:    7001000（仅 APK 发布）
Git tag:                v7.1.5
APK:                    maoyuan-v7.1.0.apk（另附同一文件 0xnuller-v7.1.0.apk 供旧版应用检测更新）
Release 标题:           猫愿 7.1.0（仅 APK 发布）
```

### 三档发布

工作流自动判断，不需要手动选择：

| 改动                                | 交付                                 | 用户                     |
| ----------------------------------- | ------------------------------------ | ------------------------ |
| 只有 Worker、价格、内容             | Workers + Web；热更新包内容不变      | 立即生效                 |
| 界面与前端逻辑                      | Web + 签名热更新包 + `v<版本>` tag   | 后台下载，下次打开即新版 |
| Rust、Kotlin 模板、插件、权限、图标 | 以上全部 + 签名 APK + GitHub Release | 提示下载安装包           |

- **原生 API**：`android/app/src-tauri/src/ota.rs` 的 `NATIVE_API` 与 `android/native-api.json`
  记录原生层指纹（`scripts/lib/native-fingerprint.mjs` 列出范围）。原生层相对最新 APK Release
  有变化时必须提升 `NATIVE_API` 并执行 `node scripts/native-fingerprint.mjs --write`；Release Guard
  与发布工作流都会拒绝未提升的改动。
- **是否出 APK**：最新 GitHub Release 即 APK 基线。`NATIVE_API` 与基线相同则只发热更新包并只
  创建 tag；不同（或手动运行时勾选 `force_apk`）则构建 APK 并创建 Release。只发热更新的版本
  不出现在 GitHub Releases 页面，旧 APK 的更新提示也不会出现。
- **版本号**：界面更新升修订号（7.1.1、7.1.2…），原生变化升次版本号（7.2.0）。
- **热更新包**：`scripts/ota-bundle.mjs` 打包 `android/app/dist`（不含 source map），用 Secret
  `OTA_SIGNING_KEY`（ed25519）签名，部署在 Web 的 `/ota/android/`。APK 只接受内置公钥签名、
  原生 API 相同、版本更新的包，逐个文件校验 SHA-256；新包下次启动生效，连续三次启动未确认则
  自动回滚且不再安装。
- **撤回**：把有问题包的 build id（main commit SHA）加入 `android/ota-revoked.json` 并发布修复
  版本。已装上的手机收到新 manifest 后立即退回上一版。APK 拒绝降级，回滚 Cloudflare 不会让
  手机退回旧界面，修复必须是更高版本。
- **密钥**：私钥只在 GitHub `production` 环境 Secret 与本地私有凭据目录；持有者可以向所有已
  安装应用推送界面代码。更换密钥需要新 APK（提升 `NATIVE_API`）。

`Release · 0xNuller` 在统一 `CI` 对同一 main SHA 成功后运行：

1. 检查 `vX.Y.Z` tag 尚未存在。
2. 以最新 APK Release 为基线判断本次是否出 APK。
3. 构建 Web 与 Android 界面；需要时构建并验证签名 APK（包名、版本、签名、ABI、权限、源码 SHA）。
4. 签名热更新包，放入 Web 构建。
5. 部署产品 Workers 与 Web。
6. 用 `/version.json` 核对线上版本和源码 SHA，并校验热更新包签名与每个文件。
7. APK 发布创建唯一 GitHub Release；界面发布只创建 tag。

产品版本未变化时工作流正常跳过，不能覆盖已有 APK、热更新包或 Release。

## DG-Kit npm 发布

七个 `@dg-kit/*` 包是固定版本组。任一公开 Kit 包需要发布时，Changesets 同步更新全组版本。
版本准备 PR 可以在 `dev` 生成，但统一的 `Publish · npm packages` 只在版本化代码进入 `main`、
对应 CI 通过后发布。工作流逐包查询 npm，已存在的版本跳过，缺失的版本发布，因此部分失败可安全重试。

## DG-MCP npm 发布

`dg-mcp` 使用独立版本。同一个 npm 工作流先发布 Kit，再等待当前源码中的 MCP Kit 依赖版本
全部可从 npm 获取；仅当 `apps/mcp/package.json` 的版本尚未存在时发布 MCP。MCP 发布不改变
产品或 Kit 版本。

Kit 与 MCP 的源码和 npm 发布权都在本仓；旧仓只保留归档。发布后可用以下命令确认 npm 状态：

```bash
npm run verify:kit
npm run verify:mcp
npm view @dg-kit/core version
npm view dg-mcp version
```

重试以 npm 上已存在的版本为准，不覆盖版本，也不为 npm 包创建产品 tag 或 GitHub Release。
Kit 与 MCP 同时升级时，先确保 Kit 已可安装，再重试 MCP；不要绕过依赖可用性检查。

## 可选择的发布入口

GitHub Actions 保留两个独立入口：

- `Release · 0xNuller`
- `Publish · npm packages`

它们可由 main 的统一 CI 自动触发，也可手动重试；手动执行仍要求所选 SHA 是当前 `main` tip，
并要求统一 CI 对同一 SHA 成功，不放宽版本不可变等门禁。

## 生产凭据命名

生产环境只使用有用途和环境前缀的名称，避免把测试 Token 误用于发布：

| 类型                          | 名称                             |
| ----------------------------- | -------------------------------- |
| npm 发布 Secret               | `NPM_PROD_PUBLISH_TOKEN`         |
| Cloudflare 发布 Secret        | `CLOUDFLARE_PROD_DEPLOY_TOKEN`   |
| Cloudflare 账户 Variable      | `CLOUDFLARE_PROD_ACCOUNT_ID`     |
| Android keystore Secret       | `ANDROID_RELEASE_KEYSTORE_B64`   |
| Android alias Secret          | `ANDROID_RELEASE_KEY_ALIAS`      |
| Android store password Secret | `ANDROID_RELEASE_STORE_PASSWORD` |
| Android key password Secret   | `ANDROID_RELEASE_KEY_PASSWORD`   |
| Android 热更新签名 Secret     | `OTA_SIGNING_KEY`                |

工作流不再读取旧名称。测试和预览凭据应使用 `*_TEST_*` 或 `*_PREVIEW_*` 前缀，并且
不能存放在 `production` / `npm-production` 环境中。

## 发布准备顺序

1. 功能和 changeset 合并到 `dev`。
2. 合并 `NPM Version Preparation` PR，消费 changeset并更新 npm 包版本/CHANGELOG。
3. 若发布产品，同时更新统一产品版本和 `docs/releases/X.Y.Z.md`。
4. 创建 `dev → main` PR；Release Guard 验证产品元数据并禁止版本倒退，维护性提交可保持版本不变。
5. merge commit 合入 `main`。
6. main 的统一 CI 根据改动运行相应责任域，对应发布线只发布自身版本发生变化的交付物。
7. 同批包含 Kit 与 MCP 时，统一 npm 工作流先发布 Kit，确认可用后再发布 MCP。Product 从同一
   monorepo SHA 构建，不等待 npm 包发布。
