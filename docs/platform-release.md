# 0xNuller 平台发布规范

这份文档只描述 0xNuller 产品版本。`@dg-kit/*` 与 `dg-mcp` 是 npm 包，使用 changesets，
不创建 0xNuller 产品 Release。

npm 包只有一条发布线：`Kit Version` 在 `dev` 创建 `changeset-release/dev` Version PR，
只更新包版本和 CHANGELOG，不发布。版本化后的代码随产品发布 PR 进入 `main`，主分支 CI
通过后由独立的 `Kit Release` 发布到 npm。产品 GitHub Release 由 `Product Release` 独占，
两者不会复用标签或 Release。

## 分支职责

- `main`：发布分支和线上唯一真源。它的 HEAD 必须对应当前已发布或正在发布的产品版本；
  npm、网页和 APK 生产发布只允许从这里发生。
- `dev`：下一版本的集成分支。所有日常功能、修复和文档 PR 都以它为 base。
- 功能分支：从最新 `dev` 创建，CI 通过后可以 squash 合并回 `dev`。

`main` 不接收普通功能分支。发布时在 `dev` 上统一升级产品版本并补发布说明，然后直接创建
`dev → main` PR。该 PR 按分支保护要求使用 **squash merge**：`dev` 保留开发提交历史，
`main` 每个产品版本只保留一个发布快照。发布后不反向 cherry-pick；下一版本继续从 `dev`
开发并生成新的 main 快照。

## 一个版本只对应一个 tag 和一个 Release

`vX.Y.Z` 同时是不可变源码边界和唯一面向用户的 GitHub Release。Release 标题为
`0xNuller X.Y.Z`，包含签名 APK，并标记为 Latest。GitHub 会自动为这个 tag 提供源码归档，
不再创建 `android-vX.Y.Z` 或第二个源码 Release。

网页版下载入口使用稳定地址：

```text
https://github.com/0xNullAI/0xNuller/releases/latest/download/0xnuller-vX.Y.Z.apk
```

因此产品 Release 必须始终是 Latest；APK 使用明确的版本化文件名
`0xnuller-vX.Y.Z.apk`，网页版链接随产品版本一起更新。

## 发布顺序

1. 所有待发布功能先进入 `dev`，且 `dev` CI 为绿色。
2. 在 `dev` 上统一更新根 package、Android package、Cargo、Tauri、lockfile 与 `versionCode`，
   新增 `docs/releases/X.Y.Z.md`。
3. 如果存在 npm Version PR，先合并它；此时只更新版本与 CHANGELOG，不发布 npm。
4. 创建唯一允许进入 `main` 的产品发布 PR：`dev → main`。Release Guard 验证无待消费
   changeset、产品版本递增和元数据一致；CI 全绿后 squash 合并。
5. `main` CI 成功后并行启动三条相互隔离的生产流程：`Product Release` 构建签名 APK 并
   创建唯一 `vX.Y.Z` 产品 Release；`Kit Release` 仅发布尚未上线的 npm 包；
   `Deploy Cloudflare` 更新线上服务。
6. 校验产品 Release 目标 commit、APK 签名/摘要、npm 包版本，并执行生产烟测。

生产修复也必须在 `dev` 完成并升级产品版本，仍然通过同一条 `dev → main` 路径发布；
不要直接提交 main，也不要创建第二条长期发布线。
