# DG-Kit 与 MCP 发布归属

发布权已经从旧仓迁移到 `0xNullAI/0xNuller`。

## 当前状态

- 旧 DG-Kit 仓已归档，Release workflow 已手动停用。
- 旧 DG-MCP 仓已归档，Auto-tag 与 Publish workflow 已手动停用。
- `@dg-kit/*` 与 `dg-mcp` 的版本准备由 `.github/workflows/kit-version.yml` 管理。
- npm 生产发布由 `.github/workflows/kit-release.yml` 管理，与产品 Release 完全分离。
- npm 已发布的包继续保留，旧版本不会删除或覆盖。

## 统一日常发布

功能 PR 携带 changeset 合并到 `dev` 后，`Kit Version` 自动创建或更新 Version PR。
合并 Version PR 只消费 changeset、更新版本与 CHANGELOG，不发布。版本化代码随产品发布
PR squash 进入 `main`，该提交通过 CI 后，`Kit Release` 才执行 `changeset publish`。
发布 tag 使用匿名 `0xNull` noreply 身份，npm 产物带 provenance。

DG-Kit 固定版本组与独立版本号的 MCP 都遵循相同准则：功能改动必须附带 changeset；只有
经过验证的 `main` 提交才能进入 `npm-production` 环境。npm 已存在的版本由 changesets 自动
跳过，禁止覆盖。`Kit Release` 不创建 `vX.Y.Z` 或 0xNuller GitHub Release。

## 验证

```bash
npm view @dg-kit/core version
npm view @dg-kit/safety version
npm view dg-mcp version
```

若发布任务失败，先检查 npm 上的实际版本和 workflow summary；不要通过删除 tag 或覆盖已发布
版本恢复。
