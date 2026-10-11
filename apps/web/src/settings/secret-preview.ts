/**
 * A recognisable hint for a pasted secret: first 6 and last 4 characters plus
 * the length, so the user can tell which key went in without revealing it.
 * Short values show only their length; surrounding whitespace is flagged
 * because it is the usual copy-paste mistake.
 */
export function secretPreview(value: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const whitespace = trimmed !== value || /\s/.test(trimmed) ? ' · 含空格或换行，请检查' : '';
  if (trimmed.length <= 12) return `已填入 ${trimmed.length} 个字符${whitespace}`;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)} · ${trimmed.length} 个字符${whitespace}`;
}
