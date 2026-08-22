# DG-Kit 与 DG-MCP npm 发布

DG-Kit 与 DG-MCP 的源码和 npm 发布权已经迁移到 `0xNullAI/0xNuller`。旧仓保持归档，旧版本
继续留在 npm；本仓不再为 npm 包创建 GitHub Release 或 tag。

## 两条独立版本线

- DG-Kit：七个 `@dg-kit/*` 包组成固定版本组，同步版本。
- DG-MCP：单独的 `dg-mcp` 版本，可在不升级 Kit 时发布。

Changesets 在 `dev` 只准备版本和 CHANGELOG。实际发布只允许读取当前 `main` HEAD：

- `Publish · DG-Kit` 只验证和发布 Kit 工作区。
- `Publish · DG-MCP` 只验证和发布 MCP 工作区。

两条工作流都先查询 npm。版本已存在时跳过，不覆盖；没有新版本时不是失败。若 Kit 和 MCP
同时升级，MCP 发布工作流会等待当前源码中的 Kit 依赖版本全部可从 npm 获取，再发布 MCP。
若等待超时，先检查或重试 Kit 发布，再重试 MCP；不要绕过依赖可用性检查。

## 验证

```bash
npm run verify:kit
npm run verify:mcp
npm view @dg-kit/core version
npm view dg-mcp version
```

失败恢复以 npm 实际状态为准，重新运行对应独立工作流；不要删除产品 tag 或创建 npm Release。
