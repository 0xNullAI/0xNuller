# @0xnullai/ui

0xNuller 设计系统与统一外壳组件：主题令牌、Dialog/Sheet、表单、设备状态、安全弹窗、侧边栏、
设置导航，以及 Chat/Voice/Control 共用的设备连接、安全上限与 Opossum 控制面板。

```tsx
import { Button, DeviceSafetyButton, OpossumControl } from '@0xnullai/ui';
import '@0xnullai/ui/styles/base.css';
```

React 与 React DOM 为 peer dependency；应用应只加载一份主题样式。

设备界面共用的 `RepeatButton`、`useRepeatAction` 和 `IntensityRing` 也由此包统一提供。
设备组件只负责展示与调用注入的动作；最终限幅、权限、命令队列与停止语义仍由设备持有者的
runtime/safety 层执行。

`registerNavigationGuard` 注册同步、可撤销的离页提示；`allowGuardedNavigation` 只供页面导航
调用，不可放在停止、退出账号或权限撤销链路。守卫收到目标和来源 URL；应检查账户实时归属，
并忽略隐藏模块。Web 的唯一历史 owner 安装 `installHistoryNavigationGuard`，为同文档 history
写入追加序号，在 capture 阶段阻止取消的 popstate 通知模块，再返回原条目。正常对象 state 字段
保持不变；不要依赖裸原始值作为 Web history state。安装前无序号旧条目采用恢复可见 URL 的降级。
