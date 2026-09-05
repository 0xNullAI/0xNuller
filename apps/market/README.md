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

上传界面按职责拆分：`components/UploadDialog.tsx` 只协调表单状态、网络请求和关闭/刷新，
模板生成、文件/压缩包解析及手动 payload 校验集中在纯 TypeScript 的 `src/web/upload-model.ts`。
鉴权、账户归属和所有者编辑权限仍由 API 与 Worker 强制执行，前端上传模型不拥有这些决策。

## API

- `GET /api/items` — 浏览和搜索
- `POST /api/items`、`/api/items/batch` — 登录后上传
- `PATCH /api/items/:id` — 所有者或管理员修改元数据；场景条目也可修改完整剧本内容
- `DELETE /api/items/:id` — 所有者或管理员删除
- `GET /api/items/admin` — 管理员查看内容
- `PATCH /api/items/:id/moderation` — 管理员隐藏或恢复内容

生产迁移和预览步骤见[部署文档](../../docs/deploy.md)。

## 许可证

[MIT](../../LICENSE)

剧本粘贴保留完整文本；超过单人 100000、多人背景 8000、角色描述 2000 字符时明确拒绝保存，
不使用浏览器 maxlength 静默截断。复制 JSON 与下载采用同一份完整内容，复制权限失败会显示下载提示。
