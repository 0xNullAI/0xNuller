import { describe, expect, it } from 'vitest';
import { parseCharacterCard } from './character-card.js';
import {
  ScriptSplitFormatError,
  buildCharacterMessages,
  buildOutlineMessages,
  buildSplitCards,
  estimateCharacterCredits,
  estimateCredits,
  estimateOutlineCredits,
  estimateTokens,
  extractJsonObject,
  parseGeneratedCharacter,
  parseOutline,
  splitAttribution,
  type ScriptOutline,
  type ScriptSource,
} from './script-splitter.js';

const own: ScriptSource = { name: '雾港', prompt: '雾港的故事。'.repeat(600), author: '我' };
const community: ScriptSource = {
  name: '雾港',
  prompt: '雾港的故事。',
  author: '@writer',
  derivedFrom: { itemId: 'item-1', name: '雾港' },
};

const outline: ScriptOutline = {
  scene: {
    name: '雾港',
    summary: '常年起雾的港口城市。',
    rules: '入夜后不能出海。',
    cast: [{ name: '林雾', oneLine: '灯塔看守' }],
  },
  characters: [
    { name: '林雾', oneLine: '灯塔看守', isMain: true },
    { name: '老周', oneLine: '酒馆老板', isMain: false },
  ],
};

const characterJson = (name = '林雾') =>
  JSON.stringify({
    name,
    summary: '守灯塔的成年女人',
    description: '背景'.repeat(100),
    personality: '冷静'.repeat(40),
    situation: '你在雾里迷路，敲响了灯塔的门。',
    boundaries: '你说停就停\n不替你说话或决定',
    greeting: '这么大的雾，你怎么还在外面？',
    exampleDialogue: `你：这里是哪？\n${name}：灯塔。先进来暖暖。`,
    tags: ['温柔', '悬疑', 'x'.repeat(30)],
  });

describe('prompts', () => {
  it('sends the full script with the writing rules', () => {
    const [system, user] = buildOutlineMessages(own);
    expect(system!.role).toBe('system');
    for (const rule of [
      '简体中文',
      '18 岁以上',
      '你说停就停、不替你说话或决定',
      '状态栏',
      '「你」',
    ])
      expect(system!.content).toContain(rule);
    expect(user!.content).toContain(own.prompt);
    expect(user!.content).toContain('"isMain"');
    expect(user!.content).toContain('最多 12 个');
  });

  it('asks for one character with the outline as context', () => {
    const [, user] = buildCharacterMessages(community, outline, '林雾');
    expect(user!.content).toContain('请为「林雾」');
    expect(user!.content).toContain('老周：酒馆老板');
    expect(user!.content).toContain(community.prompt);
    expect(user!.content).toContain('400–1200字');
  });
});

describe('parsing', () => {
  it('takes the JSON object out of fences and prose', () => {
    expect(extractJsonObject('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJsonObject('没有 JSON')).toThrow(ScriptSplitFormatError);
    expect(() => extractJsonObject('{"a":1,}')).toThrow('不完整');
    expect(() => extractJsonObject('[1] {')).toThrow(ScriptSplitFormatError);
  });

  it('validates the outline, dedupes and caps characters', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `角色${i}`, oneLine: '' }));
    const parsed = parseOutline(
      JSON.stringify({
        scene: { name: '雾港', summary: '常年起雾的港口城市。', rules: '', cast: [] },
        characters: [{ name: '角色0', isMain: true }, ...many],
      }),
    );
    expect(parsed.characters).toHaveLength(12);
    expect(parsed.characters[0]).toEqual({ name: '角色0', oneLine: '', isMain: true });
    expect(parsed.characters[1]!.isMain).toBe(false);
    expect(() =>
      parseOutline(JSON.stringify({ scene: { name: '雾港', summary: '常年起雾的港口城市。' } })),
    ).toThrow('没有找到角色');
    expect(() =>
      parseOutline(
        JSON.stringify({
          scene: { name: '雾港', summary: '长'.repeat(1300) },
          characters: [{ name: 'A' }],
        }),
      ),
    ).toThrow('太长');
  });

  it('validates a character and drops bad tags', () => {
    const character = parseGeneratedCharacter(characterJson(), '林雾');
    expect(character.name).toBe('林雾');
    expect(character.tags).toEqual(['温柔', '悬疑']);
    const short = JSON.parse(characterJson()) as Record<string, unknown>;
    short.description = '太短';
    expect(() => parseGeneratedCharacter(JSON.stringify(short), '林雾')).toThrow('人物背景');
    const noUser = JSON.parse(characterJson()) as Record<string, unknown>;
    noUser.exampleDialogue = '林雾：只有我在说话，没有对方的台词。';
    expect(() => parseGeneratedCharacter(JSON.stringify(noUser), '林雾')).toThrow('对话示例');
  });
});

describe('estimate', () => {
  const prices = { inputCreditsPerMillion: 1500, outputCreditsPerMillion: 6000 };

  it('counts about 1.5 characters per token and rounds up to whole Credit', () => {
    expect(estimateTokens(3)).toBe(2);
    expect(estimateTokens(4)).toBe(3);
    // 150,000 chars → 100,000 tokens × 1500 + 2000 × 6000 = 162,000,000 → 162 Credit.
    expect(estimateCredits(prices, [{ inputChars: 150_000, outputTokens: 2000 }])).toBe(162);
    expect(estimateCredits(prices, [{ inputChars: 1, outputTokens: 1 }])).toBe(1);
  });

  it('charges the script once per selected character', () => {
    const one = estimateCharacterCredits(prices, own, outline, ['林雾']);
    const two = estimateCharacterCredits(prices, own, outline, ['林雾', '老周']);
    expect(two).toBeGreaterThan(one);
    expect(estimateCharacterCredits(prices, own, outline, [])).toBe(0);
    expect(estimateOutlineCredits(prices, own)).toBeGreaterThan(0);
  });
});

describe('attribution and cards', () => {
  it('credits the public author and limits use to personal use', () => {
    expect(splitAttribution(community)).toEqual({
      creator: '@writer',
      license: '改编自《雾港》，由猫愿模型整理；仅供个人使用',
    });
    expect(splitAttribution(own)).toEqual({ creator: '我', license: '由猫愿模型整理' });
    expect(splitAttribution({ ...community, author: '' }).creator).toBe('原作者');
  });

  it('builds private cards: a scene and valid characters that keep their source', () => {
    let next = 0;
    const cards = buildSplitCards(
      community,
      outline,
      [parseGeneratedCharacter(characterJson(), '林雾')],
      { includeScene: true, newId: () => `id-${next++}` },
    );
    expect(cards.map((card) => [card.id, card.kind, card.name])).toEqual([
      ['id-0', 'scene', '雾港'],
      ['id-1', 'character', '林雾'],
    ]);
    expect(cards[0]!.prompt).toContain('入夜后不能出海');
    expect(cards[0]!.prompt).toContain('- 林雾：灯塔看守');
    expect(cards[0]!.characterCard).toBeUndefined();
    const character = cards[1]!;
    expect(character.id.startsWith('market-')).toBe(false);
    expect(character.derivedFrom).toEqual({ itemId: 'item-1', name: '雾港' });
    expect(parseCharacterCard(character.characterCard)).toEqual(character.characterCard);
    expect(character.characterCard).toMatchObject({
      creator: '@writer',
      license: '改编自《雾港》，由猫愿模型整理；仅供个人使用',
      greeting: '这么大的雾，你怎么还在外面？',
    });
    expect(character.prompt.startsWith('你是林雾。')).toBe(true);
    expect(character.prompt).toContain('你说停就停');
    const ownCards = buildSplitCards(own, outline, [], { includeScene: true, newId: () => 'x' });
    expect(ownCards[0]!.derivedFrom).toBeUndefined();
  });
});
