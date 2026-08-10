# 0xNuller Market

中文 | [English](README.en.md)

用于浏览和分享场景与波形的社区市场。

- 统一主站：<https://0xnullai.com/market>
- 历史版本：<https://market.0xnullai.com>

浏览无需登录。上传内容会自动归属当前账户；所有者可以编辑或删除自己的内容，管理员账户
可以处理历史内容。Market 不使用共享管理员口令或条目编辑口令。

## 本地开发

```bash
npm install
npm run db:migrate:local -w 0xnullai-market
npm run dev -w 0xnullai-market
npm run test -w 0xnullai-market
npm run typecheck -w 0xnullai-market
npm run build -w 0xnullai-market
```

Worker 使用独立的 `MARKET_IP_PEPPER` 进行上传限流；不要把它写入仓库。

## API

- `GET /api/items` — 浏览和搜索
- `POST /api/items`、`/api/items/batch` — 登录后上传
- `PATCH /api/items/:id` — 所有者或管理员修改元数据
- `DELETE /api/items/:id` — 所有者或管理员删除
- `POST /api/items/:id/report` — 举报内容

生产迁移和预览步骤见[部署文档](../../docs/deploy.md)。

## 许可证

[MIT](../../LICENSE)
