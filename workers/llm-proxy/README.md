# 0xNuller Managed LLM Worker

`https://llm.0xnullai.com` 是「猫愿模型」的 Credit 入口。所有托管文字与摄像头画面请求都转发到
火山引擎方舟（Ark）的 OpenAI 兼容 Chat Completions 接口。登录账户在请求前预留 Credit，成功后按
服务商返回的真实 Token 用量结算；明确未执行时释放预留，执行状态不明时等待后台核对。自己的 API
Key 不经过本 Worker，也不消耗 Credit。

生产脚本沿用 `dg-llm-proxy`。自定义域、日志、Auth 服务绑定、来源白名单、全局限流和关闭的
workers.dev/Preview URL 由 `wrangler.toml` 管理。

## 配置

| 名称                 | 类型   | 说明                                                                               |
| -------------------- | ------ | ---------------------------------------------------------------------------------- |
| `AI_PRICE_TABLE`     | Secret | 价格与路由表（JSON），由 `@0xnullai/ai-pricing` 解析；模型 ID 与备用模型也来自此表 |
| `VOLC_ARK_API_KEY`   | Secret | 方舟 API Key                                                                       |
| `ALLOWED_ORIGINS`    | Var    | 浏览器来源白名单                                                                   |
| `ENABLE_CHAT_VISION` | Var    | 仅在验收后设为 `true` 才开放私人聊天看图协议                                       |

仓库公开，因此这里不保存任何价格、成本或换算比例。价格表缺失或无效、或缺少 API Key 时，
`/v1/models` 与 `/v1/chat/completions` 都直接返回 503，不预留 Credit、不调用上游，绝不按默认价扣费。
密钥只写入 Cloudflare，不写入仓库、日志或文档。

## 模型与路由

- 只有一个托管文字模型。公开 id `balanced` 是默认值；旧客户端发送的 `basic`、`powerful` 仍被接受，
  三者使用同一条价格路由 `table.chat`。Auth 按公开 id 记录预留，因此这些 id 保持稳定。
- 带图片的请求（Video 的 `vision`，以及含图片的 `chat-vision`）使用 `table.vision`；`chat-vision`
  的无图工具续轮按文字路由计价。
- `/v1/models` 只列出 `balanced`、`vision`（以及开启后的 `chat-vision`），附带表中的 Credit 单价、
  价格版本和视觉单次最大预留；从不暴露上游模型 id。
- 客户端不能指定上游模型、价格或额外参数。只有 messages、tools、tool_choice、parallel_tool_calls、
  temperature、top_p、response_format 和 stop 会转发。

## 上游请求

- 每个请求都显式发送 `thinking: {type: "disabled"}`。方舟上的 DeepSeek 默认会深度思考，推理会
  占用 `max_tokens`，可能得到空回复。
- 输出上限遵从客户端的 `max_tokens`（未提供时 1024），但最多 2048。
- 流式请求总是带 `stream_options.include_usage`，否则无法计费。
- `prompt_cache_key` 只在 Auth 已核验的范围内生成：私人会话用会话 id，群 AI 用签名票据中的房间与
  角色。发送的是带域前缀的 SHA-256 摘要，原始 id 不离开 Worker。服务商自动前缀缓存命中的 Token
  在 `usage.prompt_tokens_details.cached_tokens` 中报告，并按表中的缓存单价结算。

## 备用模型

主模型返回 429、5xx、网络错误或超时，且尚未产生任何输出时，用表中的 `fallbackModel` 重试一次，
价格不变。超时界限：流式请求 30 秒内必须收到首个数据块，非流式请求 120 秒内必须返回完整结果。
一旦已经向客户端输出内容，就不再切换模型。其他 4xx 不重试，直接释放预留。两次都超时或网络失败时
请求可能已在服务商执行，预留保留为 pending 待核对。

## 预留与结算

- 预留 = `tokenReservation(路由, 估算输入 Token, 输出上限)`。文字按 UTF-8 字节数保守估算输入（包含
  工具定义与结构化输出格式），每张图片按固定的保守 Token 额度计入，不按 base64 字节计数。
- 结算 = `tokenCredits(路由, 真实 usage)`，分别计算未缓存输入、缓存输入和输出，向上取整，单次最低
  1 Credit。真实用量超过预留时不结算，保留给后台核对。
- 视觉请求的估算输入不得超过 131,072 Token，因此 `/v1/models` 给出的单次最大预留是真实上限。
  Auth 只接受与对话、`runId` 和请求摘要绑定的正整数视觉预留；具体金额由本 Worker 按价格表计算。

## 结束原因

- `length`：照常交付已经生成的部分并按真实用量结算，账单元数据记录 `finishReason: "length"` 和
  `truncated: true`，非流式响应附带 `truncated: true`。完全没有内容的截断回复不会作为成功返回：
  非流式返回 502 并说明已结算，流式在结算后以错误结束而不发送 `[DONE]`。
- `content_filter`：用一句中性回复「这个话题我没法聊，我们换个话题吧。」替换（流式则在末尾追加），
  `finish_reason` 改为 `stop`，非流式响应附带 `content_filtered: true`，账单记录 `contentFiltered`，
  只按真实用量计费。
- 方舟直接拒绝敏感输入（400 且错误码含 `SensitiveContent`）时没有执行推理：释放预留，同样回复上述
  中性文字，`credit_charged: 0`。

## 摄像头视觉

每次观察只接受一张 JPEG data URI，压缩后至多 250 KiB；请求上限 1 MiB，最多一个 system 提示和一个
带图片的 user 消息。代理对实际发送给模型的文字、图片、工具及参数计算 SHA-256，Auth 将摘要绑定到
预留并在 checkpoint 时再核对，浏览器无法决定金额或摘要。缺少 usage、用量超出预留或结果无法交付时
返回 `pending` 待账务核对，不虚构 Token。图片本身不写入数据库或会话。

`chat-vision` 只接受 `agent` 用量种类、已归属的私人会话和 runId；允许角色指令、私人 Memory、近期
文字历史、最多一张当前用户 JPEG 与有界工具往返，工具续轮不重传图片。它不支持流式输出，默认关闭并从
`/v1/models` 隐藏，只有真实验收后显式配置 `ENABLE_CHAT_VISION=true` 才开放。

## 流式计费与中断

SSE 以事件边界解析，兼容分块 CRLF 和末尾无换行的 usage。每个 JSON 事件在交付前改写 `model` 为公开
id；usage 在对应帧交付前写入 Auth checkpoint。`[DONE]` 只在 Auth 确认结算后发送，结算失败使流报错。
`[DONE]` 是读取终点，之后的 usage 不参与结算。上游一旦开始生成就会产生费用，因此客户端断开只停止
转发：Worker 继续读取上游（最多 20 秒，在断开后的 waitUntil 时限内），收到可信 usage 即按真实用量
结算。窗口内仍拿不到 usage 时，按预留的保守估算结算：输入取预留时的估算 Token，输出取已收到的字节数
（上游被截断时取输出上限），且不超过预留，账单元数据记录 `estimated: true`。客户端仍在连接、上游却
没有报告 usage 时，预留保留为 pending，由 Auth 后台标记待核对并释放冻结。非流式请求同样不因客户端
断开而中止上游调用，结果返回后照常结算。

结算/释放校验 Auth 实际终态，最多同幂等键重试 3 次，每次 RPC 最多等待 3 秒。结算超时可能已经提交，
因此始终重试 settle，绝不随后调用 release；非流式接口在未确认结算时不返回 `credit_charged`。

预留通过 Auth 的私有 `reserveManagedTextCredits`（群 AI 用 `reserveManagedGroupTextCredits`）完成，
成功后才调用上游。Auth 返回只属于该预留的 capability，留在 Worker 请求内，不发给浏览器；checkpoint、
状态查询、心跳与终结 RPC 都使用它，因此后台补偿不依赖用户会话有效期。预留 RPC 等待上限 3 秒，异常
或不合法的授权状态返回 503 和 `billing_status: unknown`，不调用模型，也不自动释放。运行期间每分钟
持久化心跳，3 秒内未确认则中止转发，未知用量保留待核对。重复 idempotency key 不重新生成。

私人文字请求可附 `X-0xNullAI-Conversation-Id` 和 `X-0xNullAI-Run-Id`，只转交 Auth 验证归属，
不进入模型输入；不属于账户或已删除的会话使预留失败。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

先部署 Auth（它接受按价格表计算的视觉预留），再部署本 Worker，并在部署前写入两个 Secret。完整顺序见
[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
