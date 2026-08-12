# DG-Kit 与 MCP 发布归属

发布权已经从旧仓迁移到 `0xNullAI/0xNuller`。

## 当前状态

- 旧 DG-Kit 仓已归档，Release workflow 已手动停用。
- 旧 DG-MCP 仓已归档，Auto-tag 与 Publish workflow 已手动停用。
- `@dg-kit/*` 由本仓 `.github/workflows/release.yml` 管理。
- `dg-mcp` 与 `@dg-kit/*` 统一由本仓 `.github/workflows/release.yml` 和 changesets 管理。
- npm 已发布的包继续保留，旧版本不会删除或覆盖。

## 统一日常发布

功能 PR 携带 changeset 合并到 `dev` 后，Release workflow 自动创建或更新 Version Packages
PR；版本 PR 进入 `main` 后自动执行 `changeset publish`。发布提交和 tag 使用匿名
`0xNull` noreply 身份，npm 产物带 provenance。

DG-Kit 固定版本组与独立版本号的 MCP 都遵循相同准则：功能改动必须附带 changeset；版本 PR
进入 `main` 后，由同一个 `npm-production` job 使用 npm token 与 provenance 发布。npm 已存在的
版本由 changesets 自动跳过，禁止覆盖。

## 验证

```bash
npm view @dg-kit/core version
npm view @dg-kit/safety version
npm view dg-mcp version
```

若发布任务失败，先检查 npm 上的实际版本和 workflow summary；不要通过删除 tag 或覆盖已发布
版本恢复。
