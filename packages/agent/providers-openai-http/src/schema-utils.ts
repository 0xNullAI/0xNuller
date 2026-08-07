const STRIP_KEYS = new Set([
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

export function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;

  const record = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRIP_KEYS.has(key)) continue;
    output[key] = strictify(value);
  }

  if (output.type === 'object' && output.properties && typeof output.properties === 'object') {
    const properties = output.properties as Record<string, unknown>;
    const propKeys = Object.keys(properties);
    const originalRequired = new Set<string>(
      Array.isArray(output.required) ? (output.required as string[]) : [],
    );

    output.required = propKeys;
    output.additionalProperties = false;

    for (const key of propKeys) {
      if (!originalRequired.has(key)) {
        properties[key] = widenWithNull(properties[key]);
      }
    }
  }

  return output;
}

export function widenWithNull(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const record = schema as Record<string, unknown>;
  const type = record.type;
  if (type == null) return schema;
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...record, type: [...type, 'null'] };
  }
  if (type === 'null') return schema;
  return { ...record, type: [type, 'null'] };
}
