import { useMemo, useState, useSyncExternalStore } from 'react';
import { Input } from '@0xnullai/ui';
import {
  getCatalogModels,
  getModelCatalogVersion,
  subscribeModelCatalog,
  type CatalogModel,
  type ProviderId,
} from '@0xnullai/llm-providers';

export interface ModelOption {
  id: string;
  label: string;
  detail?: string;
}

/**
 * The newest models.dev catalog model of a provider that supports tool calls. It is only
 * offered as a suggestion: the caller must never write it to settings until the user
 * picks it.
 */
export function useRecommendedModel(providerId: ProviderId): CatalogModel | null {
  const catalogVersion = useSyncExternalStore(subscribeModelCatalog, getModelCatalogVersion);
  return useMemo(() => {
    const models = getCatalogModels(providerId);
    if (!models) return null;
    return (
      models
        .filter((model) => model.toolCall)
        .sort((left, right) =>
          (right.releaseDate ?? '').localeCompare(left.releaseDate ?? ''),
        )[0] ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when the catalog arrives
  }, [providerId, catalogVersion]);
}

/** Searchable model field. Any id can still be typed for models not listed yet. */
export function ModelCombobox({
  value,
  onChange,
  options,
  recommended,
  onOpen,
}: {
  value: string;
  onChange: (model: string) => void;
  options: readonly ModelOption[];
  recommended: CatalogModel | null;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const typed = value.trim().toLowerCase();
  const exact = options.some((option) => option.id.toLowerCase() === typed);
  const showRecommended = Boolean(recommended && recommended.id.toLowerCase() !== typed);
  // An exact id needs no suggestions; otherwise filter by id or display name.
  const matches = exact
    ? []
    : options.filter(
        (option) =>
          option.id !== recommended?.id &&
          (!typed ||
            option.id.toLowerCase().includes(typed) ||
            option.label.toLowerCase().includes(typed)),
      );
  return (
    <div className="relative grid gap-1.5">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          onOpen?.();
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder="搜索或输入模型 ID"
        aria-label="模型"
        role="combobox"
        aria-expanded={open}
        aria-controls="llm-model-options"
      />
      {open && (showRecommended || matches.length > 0) ? (
        <div
          id="llm-model-options"
          role="listbox"
          className="absolute inset-x-0 top-11 z-30 max-h-72 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg"
        >
          {showRecommended && recommended ? (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-xs)] bg-[var(--accent-soft)] px-3 py-2 text-left text-sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(recommended.id);
                setOpen(false);
              }}
            >
              <span className="shrink-0 rounded-full border border-[var(--accent)] px-1.5 text-[10px] font-semibold text-[var(--accent)]">
                推荐
              </span>
              <span className="min-w-0 flex-1 truncate">{recommended.name || recommended.id}</span>
              <span className="shrink-0 text-xs text-[var(--text-faint)]">点击确认</span>
            </button>
          ) : null}
          {matches.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id.toLowerCase() === typed}
              className="flex w-full min-w-0 items-center justify-between gap-3 rounded-[var(--radius-xs)] px-3 py-2 text-left text-sm hover:bg-[var(--accent-soft)] aria-selected:bg-[var(--accent-soft)]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {option.detail ? (
                <span className="shrink-0 text-xs text-[var(--text-faint)]">{option.detail}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
