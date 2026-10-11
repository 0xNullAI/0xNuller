import { secretPreview } from './secret-preview';

/** Under a password field: which key is in there, without showing it. */
export function SecretHint({ value }: { value: string }) {
  const preview = secretPreview(value);
  return preview ? (
    <span className="font-mono text-[11px] text-[var(--text-faint)]" aria-live="polite">
      {preview}
    </span>
  ) : null;
}
