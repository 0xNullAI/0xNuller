interface JsonTreeProps {
  value: unknown;
  defaultOpen?: boolean;
  /** Internal: how deeply nested this node is. */
  depth?: number;
}

const VALUE_PREVIEW_LIMIT = 64;
const STRING_INLINE_LIMIT = 80;
const AUTO_OPEN_DEPTH = 1;

export function JsonTree({ value, defaultOpen, depth = 0 }: JsonTreeProps) {
  return (
    <JsonNode value={value} depth={depth} forceOpen={defaultOpen ?? depth < AUTO_OPEN_DEPTH} />
  );
}

function JsonNode({
  value,
  depth,
  forceOpen,
}: {
  value: unknown;
  depth: number;
  forceOpen?: boolean;
}) {
  if (value === null) return <span className="text-[var(--text-faint)]">null</span>;
  if (value === undefined) return <span className="text-[var(--text-faint)]">undefined</span>;

  if (typeof value === 'boolean' || typeof value === 'number') {
    return <span className="text-[var(--text)]">{String(value)}</span>;
  }

  if (typeof value === 'string') {
    return <StringNode value={value} />;
  }

  if (Array.isArray(value)) {
    return <ArrayNode value={value} depth={depth} forceOpen={forceOpen} />;
  }

  if (typeof value === 'object') {
    return (
      <ObjectNode value={value as Record<string, unknown>} depth={depth} forceOpen={forceOpen} />
    );
  }

  return <span className="text-[var(--text)]">{String(value)}</span>;
}

function StringNode({ value }: { value: string }) {
  if (value.length <= STRING_INLINE_LIMIT && !value.includes('\n')) {
    return <span className="text-[var(--text)] break-all">"{value}"</span>;
  }
  return (
    <details className="inline align-top">
      <summary className="cursor-pointer text-[var(--text)] hover:text-[var(--accent)] inline">
        "{value.slice(0, VALUE_PREVIEW_LIMIT)}…"
        <span className="ml-1 text-[10px] text-[var(--text-faint)]">({value.length} chars)</span>
      </summary>
      <pre className="mt-1 ml-4 whitespace-pre-wrap break-words rounded-[4px] bg-[var(--bg-soft)] px-2 py-1 text-[var(--text)]">
        {value}
      </pre>
    </details>
  );
}

function ArrayNode({
  value,
  depth,
  forceOpen,
}: {
  value: unknown[];
  depth: number;
  forceOpen?: boolean;
}) {
  if (value.length === 0) return <span className="text-[var(--text)]">[]</span>;
  return (
    <details open={forceOpen}>
      <summary className="cursor-pointer text-[var(--text)] hover:text-[var(--accent)] select-none">
        Array <span className="text-[var(--text-faint)]">[{value.length}]</span>
      </summary>
      <div className="border-l border-[var(--surface-border)] pl-3 ml-1">
        {value.map((item, idx) => (
          <div key={idx} className="flex gap-2">
            <span className="text-[var(--text-faint)] shrink-0">{idx}:</span>
            <div className="min-w-0 flex-1">
              <JsonNode value={item} depth={depth + 1} forceOpen={depth + 1 < AUTO_OPEN_DEPTH} />
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ObjectNode({
  value,
  depth,
  forceOpen,
}: {
  value: Record<string, unknown>;
  depth: number;
  forceOpen?: boolean;
}) {
  const keys = Object.keys(value);
  if (keys.length === 0) return <span className="text-[var(--text)]">{'{}'}</span>;
  return (
    <details open={forceOpen}>
      <summary className="cursor-pointer text-[var(--text)] hover:text-[var(--accent)] select-none">
        Object <span className="text-[var(--text-faint)]">{`{${keys.length}}`}</span>
      </summary>
      <div className="border-l border-[var(--surface-border)] pl-3 ml-1">
        {keys.map((key) => (
          <div key={key} className="flex gap-2">
            <span className="text-[var(--text)] font-medium shrink-0">{key}:</span>
            <div className="min-w-0 flex-1">
              <JsonNode
                value={value[key]}
                depth={depth + 1}
                forceOpen={depth + 1 < AUTO_OPEN_DEPTH}
              />
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
