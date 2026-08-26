import type { DeviceSnapshot } from './contracts.js';
import type { DeviceRuntimeProvider } from './runtime-provider.js';
import type { BoundDeviceTools, DeviceToolDefinition, DeviceToolName } from './tool-provider.js';
import { DEVICE_TOOL_CATALOG } from './tool-provider.js';

/**
 * The complete device surface available to models. Keep this as a positive
 * allowlist: adding a runtime tool must not make it AI-accessible by default.
 */
export const AI_DEVICE_TOOL_NAMES = [
  'device_snapshot',
  'device_vibrate',
  'device_stop',
  'device_emergency_stop',
] as const satisfies readonly DeviceToolName[];

export type AiDeviceToolName = (typeof AI_DEVICE_TOOL_NAMES)[number];

/** Shared product copy for permission prompts and tool registries. */
export const AI_DEVICE_TOOL_DISPLAY_NAMES: Readonly<Record<AiDeviceToolName, string>> = {
  device_snapshot: '读取通用设备状态',
  device_vibrate: '通用设备振动',
  device_stop: '停止通用设备功能',
  device_emergency_stop: '紧急停止通用设备',
};

/** Only output-increasing generic tools need the surface's upper consent gate. */
export const AI_DEVICE_PERMISSION_TOOL_NAMES: ReadonlySet<AiDeviceToolName> = new Set([
  'device_vibrate',
]);

export interface AiDeviceToolDefinition {
  name: AiDeviceToolName;
  description: string;
  /** SDK-neutral JSON Schema. interactionId is injected by the local adapter. */
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelDeviceToolDefinition {
  name: AiDeviceToolName;
  description: string;
  /** Agent and Voice registries both call the JSON Schema field `parameters`. */
  parameters: Readonly<Record<string, unknown>>;
}

export interface AiDeviceToolCall {
  id: string;
  name: AiDeviceToolName;
  args: Record<string, unknown>;
}

export interface AiDeviceToolAdapterOptions {
  /** May resolve lazily so synchronous AI composition does not own runtime startup. */
  tools: () => BoundDeviceTools | Promise<BoundDeviceTools>;
  /** Returns only an already-open runtime snapshot; it must not start a backend. */
  snapshot?: () => DeviceSnapshot | null;
  /** Local feature gate; disabled adapters expose no model surface. */
  enabled?: () => boolean;
}

const AI_NAME_SET: ReadonlySet<string> = new Set(AI_DEVICE_TOOL_NAMES);

const AI_DESCRIPTIONS: Record<AiDeviceToolName, string> = {
  device_snapshot:
    'List generic device capabilities and their opaque deviceId and featureId values. Use returned IDs exactly; never infer a target from a name.',
  device_vibrate:
    'Write bounded vibration to the exact opaque deviceId and featureId supplied by the runtime, with a short mandatory output lease.',
  device_stop: 'Immediately stop the exact vibration feature identified by deviceId and featureId.',
  device_emergency_stop:
    'Immediately stop all generic device output in the shared runtime session.',
};

const MODEL_FIELDS: Record<AiDeviceToolName, readonly string[]> = {
  device_snapshot: [],
  device_vibrate: ['deviceId', 'featureId', 'intensity', 'outputLeaseMs'],
  device_stop: ['deviceId', 'featureId'],
  device_emergency_stop: [],
};

/** Model schemas derived from the runtime catalog with interactionId removed. */
export const AI_DEVICE_TOOL_CATALOG: readonly AiDeviceToolDefinition[] = AI_DEVICE_TOOL_NAMES.map(
  (name) => {
    const source = requireCatalogEntry(name);
    const schema = source.inputSchema as {
      properties?: Readonly<Record<string, unknown>>;
      required?: readonly string[];
    };
    const properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'interactionId'),
    );
    const required = (schema.required ?? []).filter((key) => key !== 'interactionId');
    return {
      name,
      description: AI_DESCRIPTIONS[name],
      inputSchema: {
        ...source.inputSchema,
        properties,
        required,
        additionalProperties: false,
      },
    };
  },
);

export function isAiDeviceToolName(name: string): name is AiDeviceToolName {
  return AI_NAME_SET.has(name);
}

/** Converts the SDK-neutral inputSchema field to the registries' parameters field. */
export function toModelDeviceToolDefinitions(): ModelDeviceToolDefinition[] {
  return AI_DEVICE_TOOL_CATALOG.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

/**
 * Injects a trusted local/tool-call ID after validating the model-owned
 * object. Model input can never supply or override interactionId.
 */
export class AiDeviceToolAdapter {
  private readonly options: AiDeviceToolAdapterOptions;

  constructor(options: AiDeviceToolAdapterOptions) {
    this.options = options;
  }

  definitions(): ModelDeviceToolDefinition[] {
    return this.isAvailable() ? toModelDeviceToolDefinitions() : [];
  }

  snapshot(): DeviceSnapshot | null {
    if (this.options.enabled?.() === false) return null;
    const snapshot = this.options.snapshot?.() ?? null;
    if (!snapshot) return null;
    const controllable = sanitizeAiDeviceSnapshot(snapshot);
    return controllable.devices.length > 0 ? controllable : null;
  }

  isAvailable(): boolean {
    return this.snapshot() !== null;
  }

  async invoke(call: AiDeviceToolCall): Promise<unknown> {
    if (!isAiDeviceToolName(call.name)) {
      throw new Error(`AI device tool is not allowed: ${call.name}`);
    }
    validateInteractionId(call.id);
    validateModelArgs(call.name, call.args);

    const tools = await this.options.tools();
    if (call.name === 'device_snapshot') {
      const snapshot = (await tools.invoke(call.name, call.args)) as DeviceSnapshot;
      return sanitizeAiDeviceSnapshot(snapshot);
    }
    return tools.invoke(call.name, { ...call.args, interactionId: call.id });
  }
}

/** Bind one AI surface lazily to the shell-owned runtime without starting hardware on composition. */
export function createAiDeviceToolAdapter(
  provider: DeviceRuntimeProvider,
  moduleId: string,
): AiDeviceToolAdapter {
  if (!moduleId) throw new Error('AI device module id must not be empty');
  return new AiDeviceToolAdapter({
    tools: () => provider.forModule(moduleId),
    snapshot: () => provider.current()?.snapshot() ?? null,
    enabled: () => provider.isEnabled?.() ?? true,
  });
}

/** Models only need generic device context when they can address a healthy output feature. */
export function hasUsableAiDeviceTarget(snapshot: DeviceSnapshot): boolean {
  return snapshot.devices.some((device) =>
    device.capabilities.some((capability) => capability.kind === 'vibrate' && !capability.faulted),
  );
}

export function aiDeviceToolRequiresPermission(name: string): name is AiDeviceToolName {
  return isAiDeviceToolName(name) && AI_DEVICE_PERMISSION_TOOL_NAMES.has(name);
}

export function sanitizeAiDeviceSnapshot(snapshot: DeviceSnapshot): DeviceSnapshot {
  return {
    ...snapshot,
    devices: snapshot.devices.flatMap((device) => {
      const healthyVibration = device.capabilities.filter(
        (capability) => capability.kind === 'vibrate' && !capability.faulted,
      );
      if (healthyVibration.length === 0) return [];
      return [
        {
          ...device,
          // Advertised names may contain brands or user-provided text. Models
          // receive capabilities and exact opaque IDs only. Telemetry remains
          // useful, but faulted output features never enter the model snapshot.
          name: 'Connected device',
          capabilities: device.capabilities
            .filter((capability) => capability.kind !== 'vibrate' || !capability.faulted)
            .map((capability) => ({ ...capability })),
        },
      ];
    }),
  };
}

/**
 * Appends one compact code-owned block. Device labels are intentionally
 * omitted: only runtime-issued opaque IDs and capabilities are represented.
 */
export function appendAiDeviceRuntimeStatus(
  instructions: string,
  snapshot: DeviceSnapshot | null,
): string {
  if (!snapshot) return instructions;
  const controllable = sanitizeAiDeviceSnapshot(snapshot);
  if (controllable.devices.length === 0) return instructions;
  const status = formatAiDeviceRuntimeStatus(controllable);
  return instructions ? `${instructions}\n\n${status}` : status;
}

export function formatAiDeviceRuntimeStatus(snapshot: DeviceSnapshot): string {
  const controllable = sanitizeAiDeviceSnapshot(snapshot);
  const lines = [
    '[通用设备运行时]',
    `sessionId=${JSON.stringify(controllable.sessionId)}; devices=${controllable.devices.length}`,
  ];
  for (const device of controllable.devices) {
    const capabilities = device.capabilities.map((capability) => {
      switch (capability.kind) {
        case 'vibrate':
          return `vibrate(featureId=${JSON.stringify(capability.featureId)},steps=${capability.stepCount},faulted=${capability.faulted})`;
        case 'battery':
          return `battery(featureId=${JSON.stringify(capability.featureId)},value=${capability.value ?? 'unknown'})`;
        case 'rssi':
          return `rssi(featureId=${JSON.stringify(capability.featureId)},value=${capability.value ?? 'unknown'})`;
      }
    });
    lines.push(
      `deviceId=${JSON.stringify(device.deviceId)}; capabilities=${capabilities.join(',')}`,
    );
  }
  lines.push('调用时必须逐字使用上方 deviceId 与 featureId；不得按名称猜测。');
  return lines.join('\n');
}

function requireCatalogEntry(name: AiDeviceToolName): DeviceToolDefinition {
  const definition = DEVICE_TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing device runtime tool definition: ${name}`);
  return definition;
}

function validateInteractionId(interactionId: string): void {
  if (!interactionId || interactionId.length > 128) throw new Error('Invalid tool-call id');
}

function validateModelArgs(name: AiDeviceToolName, args: Record<string, unknown>): void {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${name}: expected object`);
  }
  const allowed = MODEL_FIELDS[name];
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new Error(`${name}: unknown field`);
  }
}
