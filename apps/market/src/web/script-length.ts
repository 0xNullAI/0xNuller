import { MAX_SCENARIO_PROMPT_LENGTH } from '../shared/schema';

/** Validate without slicing: file upload and pasted scripts must never silently lose text. */
export function scriptLengthError(fields: {
  type: string;
  prompt: string;
  setting: string;
  roles: Array<{ description: string }>;
}): string | null {
  const check = (label: string, value: string, limit: number) =>
    value.length > limit
      ? `${label}共 ${value.length.toLocaleString()} 字符，超过 ${limit.toLocaleString()} 字符上限。内容已完整保留，请缩短后再保存。`
      : null;
  if (fields.type === 'scenario') return check('剧本', fields.prompt, MAX_SCENARIO_PROMPT_LENGTH);
  if (fields.type === 'multi-scene') {
    const settingError = check('世界观 / 背景', fields.setting, 8000);
    if (settingError) return settingError;
    for (const [index, role] of fields.roles.entries()) {
      const error = check(`角色 ${index + 1} 描述`, role.description, 2000);
      if (error) return error;
    }
  }
  return null;
}
