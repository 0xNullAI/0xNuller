# DG-Playground

> 旧版 README 存档；失效的占位资源和内部部署说明没有带入 6.0.0。

独立 DG-Playground 用于探索小游戏与设备反馈的结合：游戏产生受限动作，再由平台安全层
转换为设备输出。旧仓库和旧部署在兼容期保留，但不再单独维护。

## Status

旧仓曾实验自然语言生成游戏、静态扫描、审核队列、公开目录和设备桥接。生成与发布服务端
没有进入 6.0.0 的生产运行面，也不会使用旧占位资源直接部署。

当前 Playground 已并入 0xNuller：

- 使用统一顶部设备栏连接 Coyote 或 Opossum；
- 与 Control、Agent、Voice、Chat 共享设备与安全状态；
- 游戏只能调用注册过的动作；
- 未连接设备时仍可作为普通游戏运行。

## Develop

当前模块作为统一 Web 的懒加载页面开发：

```bash
npm install
npm run dev -w @0xnullai/web
npm run test
npm run typecheck
npm run build -w @0xnullai/web
```

使用方式、代码结构和安全边界见 [Playground 模块文档](../../apps/playground/README.md)。旧版
生成、审核和存储方案只作为历史设计保留，不作为新版本部署指南。
