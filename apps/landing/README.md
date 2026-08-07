# DG-Web

0xNullAi 官网 / 着陆页 — 介绍整个 DG 系列，部署在 Cloudflare Pages，根域名 **0xnullai.com**。

- 品牌：**0xNullAi** ｜ 主标语：**娱乐和智能的边界结合**
- 技术：Astro 静态站，复用 DG 系列统一设计令牌（亮=天蓝 / 暗=金，PingFang 字体栈 + JetBrains Mono 品牌字）
- 项目网格指向各子域名：`agent.` / `chat.` / `market.` / `wiki.` `.0xnullai.com`，以及 DG-MCP / DG-Kit 的 GitHub & npm

## 开发

```bash
npm install
npm run dev      # 本地预览
npm run build    # 输出到 dist/
```

## 部署（Cloudflare Pages）

连接本仓库到 Cloudflare Pages：
- Build command: `npm run build`
- Build output directory: `dist`
- 自定义域名：`0xnullai.com`（apex）+ 可选 `www.0xnullai.com`

设计令牌见 `src/styles/global.css`，与 DG-Agent 的 `tokens.css` 保持一致；改主色时同步各站。
