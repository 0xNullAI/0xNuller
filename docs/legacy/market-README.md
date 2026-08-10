# DG-Market

> 旧版 README 存档；下文已按 6.0.0 的账户权限和统一部署方式更新失效命令。

独立 DG-Market 用于上传和交换 DG-Agent 的波形与场景。旧站继续保留在
[market.0xnullai.com](https://market.0xnullai.com)，新版本位于统一主站的 Market 模块。

## 技术栈

- 前端：React、Vite
- API：Cloudflare Worker
- 数据：Cloudflare D1
- 校验：前后端共享的数据结构

6.0.0 延续原有浏览、搜索、下载、批量上传和举报能力，并将上传、编辑、删除和管理权限
统一绑定到 Auth 账户。旧版的共享管理口令和条目编辑口令不再用于新产品流程。

## 本地开发

Market 可以独立启动以开发模块，也可以在统一 Web 外壳中联调：

```bash
npm install
npm run db:migrate:local -w 0xnullai-market
npm run dev -w 0xnullai-market
npm run test -w 0xnullai-market
npm run typecheck -w 0xnullai-market
npm run build -w 0xnullai-market
```

当前命令、API 和环境要求以 [Market 模块说明](../../apps/market/README.md) 为准。

## 部署到 Cloudflare（GitHub 推送自动部署）

Market API 保持独立 Worker 和 D1，生产界面由统一 Web 外壳提供。发布前必须备份 D1、
执行只读数据门禁并检查 migration 账本；完整步骤见[统一部署说明](../deploy.md)。旧站不会因
统一主站发布而自动下线。

## 批量上传

前端支持导入多条波形或场景。API 使用 `POST /api/items/batch`，每条内容都在同一批请求
成功后归属当前登录账户；未登录请求不会创建内容。支持的字段与单条上传相同。

## 编辑与删除内容

- 所有者可以修改或删除自己的内容。
- 管理员账户可以处理历史内容、举报和隐藏状态。
- 浏览与下载保持公开。
- 不再接受旧版共享管理口令或条目编辑口令。

旧数据库中的编辑凭证字段只为无损迁移保留，不参与新版本鉴权。

## 数据格式（与 DG-Agent 互通）

- 波形包含名称、可选简介、帧序列和可选脉冲参数。
- 场景包含名称、可选图标和提示内容。

Market 的下载结果可由 Agent、Control 和统一设置中的波形/场景功能导入。具体字段约束由
[共享数据结构](../../apps/market/src/shared/schema.ts)定义，避免文档与实现产生第二套格式。
