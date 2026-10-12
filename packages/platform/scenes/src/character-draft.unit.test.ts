import { describe, expect, it } from 'vitest';
import { emptyCharacterCard } from './character-card';
import { parseCharacterDraft } from './character-draft';
import { importExternalCardJson } from './external-character-card';

describe('public character editor draft', () => {
  it('keeps only portable public fields and drops private relationship data', () => {
    const draft = parseCharacterDraft({
      name: '小岚',
      prompt: '朋友',
      description: '',
      icon: '🎭',
      tags: [],
      card: { ...emptyCharacterCard(), memory: '私人事件' },
      relationshipId: 'private',
    });
    expect(draft?.card).toEqual(emptyCharacterCard());
    expect(JSON.stringify(draft)).not.toContain('私人事件');
    expect(JSON.stringify(draft)).not.toContain('relationshipId');
  });

  it('rejects overlong or malformed draft fields', () => {
    const base = {
      name: '小岚',
      prompt: '朋友',
      description: '',
      icon: '🎭',
      tags: [],
      card: emptyCharacterCard(),
    };
    expect(parseCharacterDraft({ ...base, prompt: 'a'.repeat(100_001) })).toBeUndefined();
    expect(parseCharacterDraft({ ...base, tags: [123] })).toBeUndefined();
    expect(parseCharacterDraft({ ...base, portraitId: 'someone-elses-image' })).toBeUndefined();
    expect(
      parseCharacterDraft({ ...base, portraitId: 'b35e4030-6451-4e94-944b-99672e98a90f' })
        ?.portraitId,
    ).toBe('b35e4030-6451-4e94-944b-99672e98a90f');
  });

  it('preserves a valid external source without turning it into private memory', () => {
    const imported = importExternalCardJson(
      JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: { name: '阿岚', description: '书屋主人', extensions: { future: true } },
      }),
    );
    const draft = parseCharacterDraft({
      name: imported.name,
      prompt: imported.prompt,
      description: imported.description,
      icon: '🎭',
      tags: imported.tags,
      card: imported.card,
      sourceArchive: imported.archive,
      memory: '不允许混入的私有记忆',
    });
    expect(draft?.sourceArchive).toEqual(imported.archive);
    expect(JSON.stringify(draft)).not.toContain('不允许混入的私有记忆');
    const sourceFileId = 'b35e4030-6451-4e94-944b-99672e98a90f';
    expect(
      parseCharacterDraft({ ...draft, sourceFileId, sourceFileName: '角色.charx' }),
    ).toMatchObject({ sourceFileId, sourceFileName: '角色.charx' });
    expect(parseCharacterDraft({ ...draft, sourceFileId })).toBeUndefined();
    expect(
      parseCharacterDraft({ ...draft, sourceFileId, sourceFileName: '../private' }),
    ).toBeUndefined();
  });
});
