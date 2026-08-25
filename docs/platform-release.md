# 0xNuller 发布体系

仓库有三条独立版本线、四类交付物。所有生产发布都只从通过对应 CI 的 `main` commit
执行；`dev` 只用于开发、集成、版本准备和测试。

| 发布线   | 交付物              | 版本来源                   | 发布位置                    |
| -------- | ------------------- | -------------------------- | --------------------------- |
| 0xNuller | Web + Android APK   | 根 `package.json`          | Cloudflare + GitHub Release |
| DG-Kit   | 7 个 `@dg-kit/*` 包 | Kit 固定 Changesets 版本组 | npm                         |
| DG-MCP   | `dg-mcp`            | `apps/mcp/package.json`    | npm                         |

DG-Kit 和 DG-MCP 不创建 GitHub tag 或 Release。GitHub Releases 页面只展示 0xNuller 产品。

## 分支职责

- 功能分支从 `dev` 创建，只合并回 `dev`。
- `dev` 可以包含 changeset、下一产品版本和发布说明，但不能部署或发布任何产物。
- `main` 是唯一生产源，只接受 `dev → main` 发布 PR，并使用 merge commit。
- 手动发布同样校验目标 SHA 等于当前 `main` HEAD，不能选择其他分支绕过。

## 0xNuller 产品发布

Web 和 Android 是同一个产品版本，必须来自同一个 `main` commit：

```text
根 package:             6.3.0
Web version.json:       6.3.0 + main commit SHA
Android versionName:    6.3.0
Android versionCode:    6003000
Git tag:                v6.3.0
APK:                    0xnuller-v6.3.0.apk
Release 标题:           0xNuller 6.3.0
```

`Release · 0xNuller` 在 `CI · Product` 和 `CI · Repository` 对同一 main SHA 成功后运行：

1. 检查 `vX.Y.Z` 尚未发布。
2. 构建 Web 和签名 Android APK。
3. 验证 APK 包名、版本、签名、ABI、权限和源码 SHA。
4. 部署产品 Workers 与 Web。
5. 用 `/version.json` 核对线上产品版本和源码 SHA。
6. 创建唯一 GitHub Release，附件只放版本化 APK；源码归档由 GitHub 自动提供。

产品版本未变化时工作流正常跳过，不能覆盖已有 APK 或 Release。

## DG-Kit npm 发布

七个 `@dg-kit/*` 包是固定版本组。任一公开 Kit 包需要发布时，Changesets 同步更新全组版本。
版本准备 PR 可以在 `dev` 生成，但 `Publish · DG-Kit` 只在版本化代码进入 `main`、对应 CI
通过后发布。工作流逐包查询 npm，已存在的版本跳过，缺失的版本发布，因此部分失败可安全重试。

## DG-MCP npm 发布

`dg-mcp` 使用独立版本。`Publish · DG-MCP` 只在 `apps/mcp/package.json` 的版本尚未存在于
npm 时发布。发布前工作流会等待当前源码中的 MCP Kit 依赖版本全部可从 npm 获取，避免同一
`main` SHA 的 Kit 与 MCP 并行发布产生不可安装窗口。MCP 发布不改变产品或 Kit 版本。

## 可选择的发布入口

GitHub Actions 保留三个独立入口：

- `Release · 0xNuller`
- `Publish · DG-Kit`
- `Publish · DG-MCP`

它们可由 main 对应 CI 自动触发，也可手动重试；手动执行仍要求所选 SHA 是当前 `main` tip，
并要求 Repository CI 和对应 Product/Kit/MCP 责任域 CI 对同一 SHA 成功，不放宽版本不可变等门禁。

## 发布准备顺序

1. 功能和 changeset 合并到 `dev`。
2. 合并 `NPM Version Preparation` PR，消费 changeset并更新 npm 包版本/CHANGELOG。
3. 若发布产品，同时更新统一产品版本和 `docs/releases/X.Y.Z.md`。
4. 创建 `dev → main` PR；Release Guard 验证至少一条版本线递增。
5. merge commit 合入 `main`。
6. main 的分域 CI 根据改动运行，对应发布线只发布自身版本发生变化的交付物。
7. 同批包含 Kit 与 MCP 时，Kit 先在 npm 可用；MCP 工作流自动等待后再发布。Product 从同一
   monorepo SHA 构建，不等待 npm 包发布。
