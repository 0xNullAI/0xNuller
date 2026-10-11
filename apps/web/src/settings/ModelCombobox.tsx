import { useId, useState } from 'react';
import { Input } from '@0xnullai/ui';

export interface ModelOption {
  id: string;
  label: string;
}

/** Searchable model field. Any id can still be typed for models not listed yet. */
export function ModelCombobox({
  value,
  onChange,
  options,
  ariaLabel = '模型',
}: {
  value: string;
  onChange: (model: string) => void;
  options: readonly ModelOption[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const typed = value.trim().toLowerCase();
  const exact = options.some((option) => option.id.toLowerCase() === typed);
  // An exact id needs no suggestions; otherwise filter by id or display name.
  const matches = exact
    ? []
    : options.filter(
        (option) =>
          !typed ||
          option.id.toLowerCase().includes(typed) ||
          option.label.toLowerCase().includes(typed),
      );
  return (
    <div className="relative grid gap-1.5">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        placeholder="搜索或输入模型 ID"
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
      />
      {open && matches.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-11 z-30 max-h-72 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg"
        >
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
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
