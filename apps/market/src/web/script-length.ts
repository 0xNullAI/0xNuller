import { MAX_SCENARIO_PROMPT_LENGTH } from '../shared/schema';

/** Validate without slicing: file upload and pasted scripts must never silently lose text. */
export function scriptLengthError(fields: { type: string; prompt: string }): string | null {
  const check = (label: string, value: string, limit: number) =>
    value.length > limit
      ? `${label}共 ${value.length.toLocaleString()} 字符，超过 ${limit.toLocaleString()} 字符上限。内容已完整保留，请缩短后再保存。`
      : null;
  if (fields.type === 'scenario') return check('剧本', fields.prompt, MAX_SCENARIO_PROMPT_LENGTH);
  return null;
}
