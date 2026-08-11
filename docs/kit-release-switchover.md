# DG-Kit 与 MCP 发布归属

发布权已经从旧仓迁移到 `0xNullAI/0xNuller`。

## 当前状态

- 旧 DG-Kit 仓已归档，Release workflow 已手动停用。
- 旧 DG-MCP 仓已归档，Auto-tag 与 Publish workflow 已手动停用。
- `@dg-kit/*` 由本仓 `.github/workflows/release.yml` 管理。
- `dg-mcp` 由本仓 `.github/workflows/release-mcp.yml` 管理。
- npm 已发布的包继续保留，旧版本不会删除或覆盖。

## DG-Kit 日常发布

功能 PR 携带 changeset 合并到 `dev` 后，Release workflow 自动创建或更新 Version Packages
PR；版本 PR 进入 `main` 后自动执行 `changeset publish`。发布提交和 tag 使用匿名
`0xNull` noreply 身份，npm 产物带 provenance。

## MCP 日常发布

MCP 使用独立的手动 workflow，必须输入与 `apps/mcp/package.json` 完全一致且尚未存在的版本。
工作流通过 npm trusted publishing 发布，拒绝覆盖已有版本。

## 验证

```bash
npm view @dg-kit/core version
npm view @dg-kit/safety version
npm view dg-mcp version
```

若发布任务失败，先检查 npm 上的实际版本和 workflow summary；不要通过删除 tag 或覆盖已发布
版本恢复。
