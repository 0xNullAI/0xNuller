# @0xnullai/observability

上线前的运行状况采集：客户端错误脱敏上报与 Worker 服务端错误计数。数据只写入 Auth D1，
管理员在「设置 → 管理 → 运行状况」查看；告警规则见 [部署文档](../../../docs/deploy.md#运行状况与告警)。

```ts
// Web 外壳与 Android 外壳启动时各安装一次（同一份代码）
import {
  installClientErrorReporting,
  reportModuleError,
} from '@0xnullai/observability/client-reporter';

// Worker 默认导出外包一层错误计数
import { withServerErrorCounting } from '@0xnullai/observability';
export default withServerErrorCounting(handler, { worker: 'market', sink: (env) => env.AUTH });
```

## 客户端上报

- 捕获未处理异常、未处理 Promise 拒绝和模块错误边界（`ModuleErrorBoundary`）中的渲染错误。
- 上报内容：截断后的错误信息与调用栈、模块 ID、产品版本与构建号、平台（web/android）、
  去掉查询参数且把人名/房间等动态段替换为 `:param` 的路由、时间和每次启动随机生成且不持久化的
  会话 ID。
- 绝不上报：聊天或提示词内容、请求体、查询参数、Cookie、令牌、密钥、邮箱、用户名或账户 ID。
  请求使用 `credentials: 'omit'`，不带 Cookie 或 Bearer。非 `Error` 的拒绝值只记录类型。
- 文本脱敏：URL 去查询串与片段；Bearer/JWT/`key=value` 形式的密钥、邮箱、UUID、长十六进制、
  长随机串、7 位以上数字、长引号文本与长段中文均被替换。服务端对每份报告重新执行同一脱敏。
- 客户端限流：同一错误（模块 + 消息 + 首帧）10 分钟内只报一次；每分钟最多 5 条，每次启动最多
  50 条；发送失败直接丢弃，不重试。

## 服务端计数

`withServerErrorCounting` 记录 5xx 响应、fetch 抛出的异常和失败的 cron（包括 `waitUntil`
中被拒绝的后台任务）。它不改变响应、原样抛出原异常；计数在 isolate 内合并，约 1 秒后通过
`waitUntil` 一次写出。绑定缺失、Auth 旧版本或写入失败都只会丢失计数，不影响请求。
