import { describe, expect, it } from 'vitest';
import { parseCharacterCard, characterCardContext } from './character-card.js';
import { CHARACTER_TEMPLATES } from './character-templates.js';

describe('public character card boundary', () => {
  it('将结构化公开设定交给模型，但不携带许可、记忆或私人关系字段', () => {
    const context = characterCardContext({
      ...CHARACTER_TEMPLATES[0]!.characterCard,
      memory: 'secret-unique',
      relationshipId: 'private-id',
    });
    expect(context).toContain(CHARACTER_TEMPLATES[0]!.characterCard.personality);
    expect(context).not.toContain('secret-unique');
    expect(context).not.toContain('private-id');
    expect(context).toContain('不授予工具或设备权限');
  });

  it('keeps public metadata while excluding account memory and relationship data', () => {
    const card = CHARACTER_TEMPLATES[0]!.characterCard;
    expect(
      parseCharacterCard({
        ...card,
        memory: 'private',
        userName: 'private',
        relationshipHistory: ['private'],
      }),
    ).toEqual(card);
  });

  it('rejects malformed versions and excessive metadata without treating third-party formats as native cards', () => {
    const card = CHARACTER_TEMPLATES[0]!.characterCard;
    expect(parseCharacterCard({ ...card, schemaVersion: 2 })).toBeUndefined();
    expect(parseCharacterCard({ ...card, description: 'a'.repeat(4_001) })).toBeUndefined();
    expect(parseCharacterCard({ ...card, tags: [null] })).toBeUndefined();
    expect(parseCharacterCard({ spec: 'chara_card_v2', data: card })).toBeUndefined();
  });
});
