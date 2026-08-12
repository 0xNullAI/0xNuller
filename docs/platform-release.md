# 0xNuller 平台发布规范

这份文档只描述 0xNuller 产品版本。`@dg-kit/*` 与 `dg-mcp` 是 npm 包，使用 changesets，
不创建 0xNuller 产品 Release。

## 分支职责

- `main`：线上唯一真源。它的 HEAD 必须对应当前已发布或正在发布的产品版本。
- `dev`：下一版本的集成分支。所有日常功能、修复和文档 PR 都以它为 base。
- 功能分支：从最新 `dev` 创建，CI 通过后可以 squash 合并回 `dev`。

`main` 不接收普通功能分支。发布时在 `dev` 上统一升级产品版本并补发布说明，然后直接创建
`dev → main` PR。该 PR 必须使用 **merge commit**，不能 squash 或 rebase；这样 `main` 会真实
包含 `dev` 的历史，发布后不需要再把相同提交 cherry-pick 回 `dev`。

## 一个版本只对应一个产品 Release

每个版本保留两个 Git tag，但只有一个 GitHub Release：

- `vX.Y.Z`：不可变源码边界，仅创建 tag，不创建 GitHub Release。
- `android-vX.Y.Z`：唯一面向用户的 GitHub Release，标题为 `0xNuller X.Y.Z`，包含签名 APK，
  并标记为 Latest。

保留 `android-v` 前缀是为了兼容已经发布的 Android 更新检查器。网页版下载入口使用稳定地址：

```text
https://github.com/0xNullAI/0xNuller/releases/latest/download/app-universal-release.apk
```

因此 Android Release 必须始终是 Latest，APK 文件名也不能改变。

## 发布顺序

1. 所有待发布功能先进入 `dev`，且 `dev` CI 为绿色。
2. 在 `dev` 上统一更新根 package、Android package、Cargo、Tauri、lockfile 与 `versionCode`，
   新增 `docs/releases/X.Y.Z.md`。
3. 创建唯一允许进入 `main` 的产品发布 PR：`dev → main`。
4. Release Guard 验证版本递增和元数据一致；CI 全绿后使用 merge commit 合并。
5. `main` CI 成功后并行执行：Cloudflare 部署、`vX.Y.Z` 源码标签、签名 Android Release。
6. 校验 GitHub Release 的目标 commit、APK 签名/摘要，并执行生产烟测。

如果生产修复必须从 `main` 开始，先把 `main` merge 到 `dev`，在 `dev` 完成修复与版本升级，
仍然通过同一条 `dev → main` 路径发布；不要创建第二条长期分叉的发布线。
