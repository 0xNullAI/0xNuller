import { describe, expect, it } from 'vitest';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';
import { parseLegalMarkdown } from './legal-markdown';
import { isLegalTermsPath } from './legal-routes';
import { USER_AGREEMENT_MARKDOWN } from './user-agreement';

describe('用户协议地址', () => {
  it('只识别 /legal/terms', () => {
    expect(isLegalTermsPath('/legal/terms')).toBe(true);
    expect(isLegalTermsPath('/legal/terms/')).toBe(true);
    expect(isLegalTermsPath('/LEGAL/Terms')).toBe(true);
    expect(isLegalTermsPath('/legal/privacy')).toBe(false);
    expect(isLegalTermsPath('/legal')).toBe(false);
    expect(isLegalTermsPath('/settings/legal/terms')).toBe(false);
  });
});

describe('用户协议', () => {
  it('写明当前版本，且保持简短', () => {
    expect(USER_AGREEMENT_MARKDOWN).toContain(`版本：${LEGAL_TERMS_VERSION}`);
    expect(USER_AGREEMENT_MARKDOWN).not.toContain('【');
    expect(USER_AGREEMENT_MARKDOWN.length).toBeLessThan(1500);
  });

  it('沿用使用须知，并写明成年、非医疗、立刻停止与他人同意', () => {
    for (const { title } of SAFETY_NOTICE_SECTIONS)
      expect(USER_AGREEMENT_MARKDOWN).toContain(`## ${title}`);
    for (const phrase of [
      '年满 18 周岁',
      '不是医疗器械',
      '心脏起搏器',
      '孕期',
      '癫痫',
      '立刻停止',
      '事先明确、自愿的同意',
    ]) {
      expect(USER_AGREEMENT_MARKDOWN).toContain(phrase);
    }
  });
});

describe('Markdown 子集', () => {
  it('解析标题、列表、提示与段落', () => {
    expect(
      parseLegalMarkdown('> **注意** 一\n\n## 标题\n\n### 小节\n\n- 甲\n- 乙\n\n行一\n行二'),
    ).toEqual([
      { kind: 'note', text: '**注意** 一' },
      { kind: 'heading', level: 2, text: '标题' },
      { kind: 'heading', level: 3, text: '小节' },
      { kind: 'list', items: ['甲', '乙'] },
      { kind: 'paragraph', lines: ['行一', '行二'] },
    ]);
  });
});
