# @0xnullai/ui

0xNuller 设计系统与统一外壳组件：主题令牌、Dialog/Sheet、表单、设备状态、安全弹窗、侧边栏
和设置导航。

```tsx
import { Button, Dialog, Sheet } from '@0xnullai/ui';
import '@0xnullai/ui/styles/base.css';
```

React 与 React DOM 为 peer dependency；应用应只加载一份主题样式。

设备界面共用的 `RepeatButton`、`useRepeatAction` 和 `IntensityRing` 也由此包统一提供。
