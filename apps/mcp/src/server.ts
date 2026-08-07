/**
 * MCP server: turns `@dg-kit/tools` tool definitions into MCP tools and
 * routes their execution plans through the `DeviceManager`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createDefaultToolRegistry,
  createSlidingWindowRateLimitPolicy,
  type ToolRegistry,
} from '@dg-kit/tools';
import type { ToolCall, ToolExecutionPlan } from '@dg-kit/core';
import { DeviceManager, type ConnectedDevice } from './device-manager.js';
import type { NodeWaveformLibrary } from './waveform-library.js';

export interface DgMcpServerOptions {
  deviceManager: DeviceManager;
  waveformLibrary: NodeWaveformLibrary;
  /** Sliding-window cap (ms) for per-tool rate limits. Default 5000. */
  rateLimitWindowMs?: number;
}

export function createDgMcpServer(options: DgMcpServerOptions): Server {
  const policy = createSlidingWindowRateLimitPolicy({
    windowMs: options.rateLimitWindowMs ?? 5_000,
    caps: {
      shock_adjust: 2,
      shock_burst: 1,
      design_wave: 1,
      vibrate_adjust: 2,
      vibrate_burst: 1,
    },
  });

  const registry: ToolRegistry = createDefaultToolRegistry({
    waveformLibrary: options.waveformLibrary,
    rateLimitPolicy: policy,
  });

  const deviceManager = options.deviceManager;

  const server = new Server(
    {
      name: 'dg-mcp',
      version: '1.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const definitions = await registry.listDefinitions();
    const builtIn: Tool[] = definitions.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters as Tool['inputSchema'],
    }));

    // Plus MCP-specific tools that don't go through the registry:
    builtIn.push(
      {
        name: 'scan',
        description:
          '扫描附近的 DG-Lab 设备（郊狼 / 爪印 / 灵猫边缘控制 / 负鼠）。返回包含 address / name / rssi / deviceKind 的列表。',
        inputSchema: {
          type: 'object',
          properties: {
            timeoutMs: {
              type: 'integer',
              minimum: 500,
              maximum: 30_000,
              description: '扫描时长（毫秒），默认 5000。',
            },
          },
        },
      },
      {
        name: 'connect',
        description:
          '连接到指定的 DG-Lab 设备。需先调用 scan 获取地址。可多次调用以连接多台不同设备；对已连接地址重复调用会报错。',
        inputSchema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: 'BLE 地址（aa:bb:cc:dd:ee:ff）',
            },
          },
          required: ['address'],
        },
      },
      {
        name: 'disconnect',
        description: '断开设备连接。指定 address 则只断开该设备，省略则断开全部已连接设备。',
        inputSchema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: '要断开的 BLE 地址，省略则断开全部。',
            },
          },
        },
      },
      {
        name: 'get_status',
        description: '查询所有已连接设备的状态（连接状态 / 强度或振动 / 波形 / 电池等，按设备类型而定）。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_sensor_state',
        description:
          '查询已连接的爪印 / 灵猫边缘控制传感器的最新读数（事件流缓存的最近一次上报）。可选 address 只查询单个设备。',
        inputSchema: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              description: '要查询的 BLE 地址，省略则返回全部传感器设备。',
            },
          },
        },
      },
      {
        name: 'list_connected_devices',
        description: '列出当前已连接的全部设备：{ address, deviceKind, connected }。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_waveforms',
        description: '列出当前波形库中的所有波形（内置 + 已导入）。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'load_waveforms',
        description: '从指定路径加载 .pulse 文件或包含 .pulse 的 .zip。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '绝对文件路径' },
          },
          required: ['path'],
        },
      },
      {
        name: 'emergency_stop',
        description: '紧急停止：所有已连接设备的强度/振动输出归零。',
        inputSchema: { type: 'object', properties: {} },
      },
    );

    return { tools: builtIn };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    try {
      // MCP-specific tools handled here directly.
      switch (name) {
        case 'scan': {
          const timeoutMs = typeof safeArgs.timeoutMs === 'number' ? safeArgs.timeoutMs : 5_000;
          const results = await deviceManager.scan(timeoutMs);
          return jsonResult({ devices: results });
        }
        case 'connect': {
          const address = String(safeArgs.address ?? '');
          if (!address) throw new Error('connect 需要 address 参数');
          const result = await deviceManager.connect(address);
          return jsonResult({ ok: true, ...result });
        }
        case 'disconnect': {
          const address =
            typeof safeArgs.address === 'string' && safeArgs.address.length > 0
              ? safeArgs.address
              : undefined;
          await deviceManager.disconnect(address);
          return jsonResult({ ok: true });
        }
        case 'get_status': {
          return jsonResult({ devices: deviceManager.getStatuses() });
        }
        case 'get_sensor_state': {
          const address =
            typeof safeArgs.address === 'string' && safeArgs.address.length > 0
              ? safeArgs.address
              : undefined;
          return jsonResult({ sensors: deviceManager.getSensorSnapshots(address) });
        }
        case 'list_connected_devices': {
          return jsonResult({ devices: deviceManager.list() });
        }
        case 'list_waveforms': {
          const waveforms = await options.waveformLibrary.list();
          return jsonResult({
            waveforms: waveforms.map((w) => ({
              id: w.id,
              name: w.name,
              description: w.description,
              frameCount: w.frames.length,
            })),
          });
        }
        case 'load_waveforms': {
          const path = String(safeArgs.path ?? '');
          if (!path) throw new Error('load_waveforms 需要 path 参数');
          const result = await options.waveformLibrary.importPath(path);
          return jsonResult(result);
        }
        case 'emergency_stop': {
          await deviceManager.emergencyStopAll();
          return jsonResult({ ok: true });
        }
      }

      // Registry-backed tools (shock_start / shock_stop / shock_adjust /
      // shock_change_wave / shock_burst / design_wave / vibrate_* /
      // set_indicator_color / timer). Old pre-1.9.0 Coyote names still
      // resolve via the registry's alias mechanism.
      const toolCall: ToolCall = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        args: safeArgs,
      };
      const plan: ToolExecutionPlan = await registry.resolve(toolCall);

      if (plan.type === 'device') {
        const entry = deviceManager.findSingleByKind('coyote');
        const result = await entry.adapter.execute(plan.command);
        return jsonResult({ ok: true, state: result.state });
      }

      if (plan.type === 'opossum') {
        const entry = deviceManager.findSingleByKind('opossum');
        const state = await entry.adapter.execute(plan.command);
        return jsonResult({ ok: true, state });
      }

      if (plan.type === 'setIndicatorColor') {
        const entry = deviceManager.findSingleByKind(plan.deviceKind);
        return jsonResult(await applyIndicatorColor(entry, plan.color));
      }

      if (plan.type === 'inline') {
        return { content: [{ type: 'text', text: plan.output }] };
      }

      if (plan.type === 'timer') {
        // Stateless MCP server has no notion of "turns" to resume into.
        return jsonResult({
          ok: false,
          reason: 'timer 工具在 MCP 模式下不受支持，请改用客户端侧的延时机制',
        });
      }

      // Exhaustiveness guard: fails to typecheck if @dg-kit/core adds a new
      // ToolExecutionPlan variant we haven't handled above.
      const _exhaustive: never = plan;
      throw new Error(`未知的执行计划类型：${JSON.stringify(_exhaustive)}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason }) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * `set_indicator_color` is pure appearance ("不影响任何强度/振动输出，纯外观" per
 * the registry tool description). Paw-prints has a dedicated solid-color
 * command. Opossum's LED command packet also carries a button-state-
 * reporting toggle; we default that to `true` (keep button events flowing)
 * since the tool is only supposed to change color, not silently disable
 * button reporting. Civet-edging has no dedicated "set color" opcode --
 * color rides along with the pressure-reporting toggle packet -- so its
 * adapter exposes `setIndicatorColor()`, which re-sends that packet with
 * the current streaming state preserved (unlike calling
 * `startPressureReporting`/`stopPressureReporting` directly, which would
 * force streaming on/off as a side effect of a purely cosmetic change).
 */
async function applyIndicatorColor(
  entry: ConnectedDevice,
  color: number,
): Promise<{ ok: boolean; reason?: string }> {
  switch (entry.kind) {
    case 'paw-prints':
      await entry.adapter.setLedSolid(color);
      return { ok: true };
    case 'opossum':
      await entry.adapter.setLed(color, true);
      return { ok: true };
    case 'civet-edging':
      await entry.adapter.setIndicatorColor(color);
      return { ok: true };
    case 'coyote':
      return { ok: false, reason: '郊狼设备没有可设置的指示灯' };
  }
}

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

export async function runStdioServer(options: DgMcpServerOptions): Promise<void> {
  const server = createDgMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
