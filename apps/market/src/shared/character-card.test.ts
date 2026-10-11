import { describe, expect, it } from 'vitest';
import {
  annotateScenarioContent,
  ItemPatchSchema,
  ScenarioContentSchema,
  UploadSchema,
} from './schema';
const characterCard = {
  schemaVersion: 1,
  description: '夜间书屋的店主',
  personality: '安静、好奇',
  greeting: '想聊聊今天吗？',
  exampleDialogue: '用户：你好\n角色：欢迎回来',
  tags: ['陪伴'],
  creator: '原创作者',
  license: 'MIT',
};
describe('Market公开角色卡', () => {
  it('保留发布、规模标记、编辑的完整公开设定，排除私人字段', () => {
    const uploaded = UploadSchema.parse({
      type: 'scenario',
      name: '书屋',
      content: {
        prompt: '书屋店主',
        characterCard: { ...characterCard, relationshipId: 'private', memories: ['private'] },
      },
    });
    expect(uploaded.type).toBe('scenario');
    if (uploaded.type !== 'scenario') throw new Error('wrong type');
    expect(annotateScenarioContent(uploaded.content)).toEqual({
      prompt: '书屋店主',
      characterCard,
    });
    expect(
      ItemPatchSchema.parse({ expectedRevision: 1, content: uploaded.content }).content,
    ).toEqual(uploaded.content);
  });

  it('rejects publishing source JSON with unresolved local container references', () => {
    const sourceArchive = {
      format: 'ccv3',
      raw: {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: '角色',
          assets: [
            {
              type: 'icon',
              name: 'main',
              ext: 'png',
              uri: 'embeded://assets/icon/images/main.png',
            },
          ],
        },
      },
    };
    expect(
      ScenarioContentSchema.safeParse({
        prompt: '人设',
        characterCard,
        sourceArchive,
      }).success,
    ).toBe(false);
  });
  it('拒绝超过限制的人设，不静默丢弃或截断字段', () => {
    expect(
      UploadSchema.safeParse({
        type: 'scenario',
        name: '书屋',
        content: {
          prompt: '原内容',
          characterCard: { ...characterCard, personality: '字'.repeat(4001) },
        },
      }).success,
    ).toBe(false);
    expect(
      UploadSchema.safeParse({ type: 'scenario', name: '旧场景', content: { prompt: '旧文本' } })
        .success,
    ).toBe(true);
  });

  it('存储原始角色卡时保留未知字段，显式移除后不保留原件', () => {
    const sourceArchive = {
      format: 'ccv3',
      raw: {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: '阿岚', extensions: { future: true } },
      },
    };
    const upload = UploadSchema.parse({
      type: 'scenario',
      name: '阿岚',
      content: { prompt: '阿岚的人设', characterCard, sourceArchive },
    });
    if (upload.type !== 'scenario') throw new Error('wrong type');
    expect(annotateScenarioContent(upload.content).sourceArchive).toEqual(sourceArchive);
    const removed = ItemPatchSchema.parse({
      expectedRevision: 1,
      content: {
        prompt: '阿岚的人设',
        characterCard,
        sourceArchive: null,
      },
    });
    expect(
      removed.content && 'sourceArchive' in removed.content && removed.content.sourceArchive,
    ).toBeNull();
  });
});

it('refuses a card edit that does not name the revision it was made from', () => {
  expect(ItemPatchSchema.safeParse({ name: '新名字' }).success).toBe(false);
  expect(ItemPatchSchema.safeParse({ expectedRevision: 3, name: '新名字' }).success).toBe(true);
});
