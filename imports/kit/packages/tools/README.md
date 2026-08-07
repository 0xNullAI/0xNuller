# @dg-kit/tools

LLM-facing tool definitions for DG-Lab Coyote control.

13 tools, all generating JSON Schema for direct injection into OpenAI / Anthropic / MCP tool-call APIs: five Coyote tools (`shock_start`, `shock_stop`, `shock_adjust`, `shock_change_wave`, `shock_burst`), five Opossum tools (`vibrate_start`, `vibrate_stop`, `vibrate_adjust`, `vibrate_change_pattern`, `vibrate_burst`), `design_wave`, `set_indicator_color`, and `timer`. Pre-1.9.0 Coyote names (`start`, `stop`, `adjust_strength`, `change_wave`, `burst`) still resolve via alias — `listDefinitions()` just no longer advertises them. Each tool validates its inputs (zod) and returns a `ToolExecutionPlan` — a `DeviceCommand`/`OpossumCommand` for the device tools, an inline string for `design_wave` after saving, a `setIndicatorColor` plan, or a `TimerCommand` for `timer`.

## Rate-limit policy

Tools that hint at "per-turn" caps (`shock_adjust`, `shock_burst`, `vibrate_adjust`, `vibrate_burst`, `design_wave`) accept an injectable `RateLimitPolicy`. Consumers pick the implementation that matches their runtime model:

- **DG-Agent** (turn-based): `createTurnRateLimitPolicy()` — counters reset on each new user turn.
- **DG-MCP** (stateless RPC): `createSlidingWindowRateLimitPolicy({ windowMs })` — keeps a timestamp ring and rejects calls that exceed the window cap.
- **No-op**: `createNoOpRateLimitPolicy()` — always allows; useful in tests.

```ts
import { createDefaultToolRegistry } from '@dg-kit/tools';

const registry = createDefaultToolRegistry({
  waveformLibrary,
  rateLimitPolicy: createSlidingWindowRateLimitPolicy({ windowMs: 5000 }),
});

const tools = await registry.listDefinitions(); // → ToolDefinition[]
const plan = await registry.resolve(toolCall); // → ToolExecutionPlan
```
