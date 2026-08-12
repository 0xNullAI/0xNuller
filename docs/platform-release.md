# 0xNuller 平台发布规范

这份文档只描述 0xNuller 产品版本。`@dg-kit/*` 与 `dg-mcp` 是 npm 包，使用 changesets，
不创建 0xNuller 产品 Release。

npm 包只有一条发布线：changesets 在 `dev` 创建 `changeset-release/dev` Version PR；合并后
由 `dev` 发布到 npm。`main` 不运行 npm 发布，也不创建 `changeset-release/main`。产品发布
PR 如果仍包含未消费的 `.changeset/*.md` 会被 Release Guard 拒绝，必须先合并 Version PR。

## 分支职责

- `main`：线上唯一真源。它的 HEAD 必须对应当前已发布或正在发布的产品版本。
- `dev`：下一版本的集成分支。所有日常功能、修复和文档 PR 都以它为 base。
- 功能分支：从最新 `dev` 创建，CI 通过后可以 squash 合并回 `dev`。

`main` 不接收普通功能分支。发布时在 `dev` 上统一升级产品版本并补发布说明，然后直接创建
`dev → main` PR。该 PR 必须使用 **merge commit**，不能 squash 或 rebase；这样 `main` 会真实
包含 `dev` 的历史，发布后不需要再把相同提交 cherry-pick 回 `dev`。

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
3. 如果存在 npm Version PR，先合并它并确认 npm 发布成功；再创建唯一允许进入 `main` 的
   产品发布 PR：`dev → main`。
4. Release Guard 验证版本递增和元数据一致；CI 全绿后使用 merge commit 合并。
5. `main` CI 成功后并行执行 Cloudflare 部署和统一产品 Release；发布工作流构建签名 APK，
   再一次性创建 `vX.Y.Z` tag/Release。
6. 校验 GitHub Release 的目标 commit、APK 签名/摘要，并执行生产烟测。

如果生产修复必须从 `main` 开始，先把 `main` merge 到 `dev`，在 `dev` 完成修复与版本升级，
仍然通过同一条 `dev → main` 路径发布；不要创建第二条长期分叉的发布线。
