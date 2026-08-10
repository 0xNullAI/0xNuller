# 0xNuller Playground

中文 | [English](README.en.md)

把游戏事件映射为受安全策略约束的设备反馈。当前 6.0.0 版本内置贪吃蛇，也支持不连接设备的
纯游戏模式。

## 使用

1. 从顶部设备横栏连接设备；也可以跳过此步。
2. 选择游戏并开始。
3. 游戏只提交固定动作，实际输出仍受全局设备安全设置限制。
4. 切换模块或使用顶部停止操作会结束当前设备控制权。

## 本地开发

Playground 作为统一 Web 的懒加载模块运行：

```bash
npm install
npm run dev -w @0xnullai/web
npm run test
npm run typecheck
npm run build -w @0xnullai/web
```

## 代码结构

```text
src/App.tsx                 游戏列表与入口
src/games.ts                游戏注册表
src/games/snake/            贪吃蛇实现与测试
src/use-game-device.ts      游戏动作到设备能力的桥接
```

设备桥只接受注册过的动作，不执行游戏生成的任意脚本或任意设备命令。

## 旧版 DG-Playground

旧仓曾实验自然语言生成游戏、静态扫描、审核队列和公开目录。该服务端生成管线没有进入
6.0.0 的生产运行面；旧仓和旧部署在兼容期保留为历史版本。若以后恢复生成与发布功能，
需要先重新完成安全审查、存储迁移和 Cloudflare 资源配置，不能把旧占位配置直接上线。

## 协议

[MIT](../../LICENSE)
