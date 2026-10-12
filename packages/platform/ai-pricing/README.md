# @0xnullai/ai-pricing

托管 AI 的单一价格与路由来源。仓库公开，因此这里只有结构和计算：每个 Worker 在运行时从密钥
`AI_PRICE_TABLE`（JSON）读取模型 ID 与 Credit 单价。缺少或无效时，对应能力关闭，不会按默认价扣费。

```ts
import { parsePriceTable, tokenCredits } from '@0xnullai/ai-pricing';

const table = parsePriceTable(env.AI_PRICE_TABLE);
const credits = table && tokenCredits(table.chat, usage);
```

- 表中的数值已是最终 Credit 单价；成本与换算只保存在仓库外，由
  `scripts/build-ai-price-table.mjs <私有成本文件>` 生成后写入 Worker 密钥。
- 按 token 计价的能力一律按服务商最高档单价配置，计费结果向上取整。
- 测试使用 `src/example-price-table.json` 中的虚构数值。
