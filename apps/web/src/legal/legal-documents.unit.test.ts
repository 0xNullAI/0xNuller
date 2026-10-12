import { describe, expect, it } from 'vitest';
import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';
import { parseLegalMarkdown } from './legal-markdown';
import { legalDocumentFromPath, legalDocumentPath } from './legal-routes';
import { PRIVACY_POLICY_MARKDOWN } from './privacy-policy';
import { USER_AGREEMENT_MARKDOWN } from './user-agreement';

describe('法律文档地址', () => {
  it('只识别两个公开地址', () => {
    expect(legalDocumentFromPath('/legal/privacy')).toBe('privacy');
    expect(legalDocumentFromPath('/legal/terms/')).toBe('terms');
    expect(legalDocumentFromPath('/LEGAL/Terms')).toBe('terms');
    expect(legalDocumentFromPath('/legal')).toBeNull();
    expect(legalDocumentFromPath('/legal/other')).toBeNull();
    expect(legalDocumentFromPath('/settings/legal/terms')).toBeNull();
    expect(legalDocumentPath('privacy')).toBe('/legal/privacy');
  });
});

describe.each([['隐私政策', PRIVACY_POLICY_MARKDOWN]])('%s', (_name, source) => {
  it('开头标明草稿与待法务审阅，并写明当前版本', () => {
    const [first] = parseLegalMarkdown(source);
    expect(first).toMatchObject({ kind: 'note' });
    expect(first?.kind === 'note' && first.text).toContain('草稿 · 待法务审阅');
    expect(source).toContain(`版本：${LEGAL_TERMS_VERSION}`);
  });

  it('只用占位符代替运营方信息', () => {
    expect(source).toContain('【公司名称】');
    expect(source).toContain('【联系邮箱】');
    expect(source).toContain('【生效日期】');
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
