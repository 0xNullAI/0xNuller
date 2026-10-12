import { expect, it } from 'vitest';
import { secretPreview } from './secret-preview';

it('shows the start, end and length of a pasted key', () => {
  expect(secretPreview('sk-ant-api03-abcdefghijklmnopWXYZ')).toBe('sk-ant…WXYZ · 33 个字符');
});

it('reveals nothing of a short value and flags pasted whitespace', () => {
  expect(secretPreview('')).toBeNull();
  expect(secretPreview('short')).toBe('已填入 5 个字符');
  expect(secretPreview(' sk-ant-api03-abcdefghijklmnopWXYZ\n')).toBe(
    'sk-ant…WXYZ · 33 个字符 · 含空格或换行，请检查',
  );
});
