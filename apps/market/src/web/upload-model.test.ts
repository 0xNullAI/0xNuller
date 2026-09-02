import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildManualUploadPayload,
  createUploadTemplate,
  parseUploadFile,
  parseWaveInput,
  type ManualUploadFields,
} from './upload-model';
import {
  EXTRA_LARGE_SCENARIO_SCALE,
  MAX_SCENARIO_PROMPT_LENGTH,
  ScenarioContentSchema,
  STANDARD_SCENARIO_PROMPT_LENGTH,
} from '../shared/schema';

const pulse = 'Dungeonlab+pulse:测试波形=0,0,0,1,1/20-0,40-0';

function manualFields(patch: Partial<ManualUploadFields> = {}): ManualUploadFields {
  return {
    type: 'waveform',
    waveformModality: 'electrostimulation',
    name: ' 测试 ',
    author: '',
    description: '',
    icon: '🎭',
    tagsText: '',
    waveInput: '[[10,20]]',
    prompt: '',
    setting: '',
    playerMin: '2',
    playerMax: '4',
    aiMode: 'none',
    roles: [{ name: '', description: '', aiPlayable: false }],
    ...patch,
  };
}

describe('upload model', () => {
  it('parses pulse and JSON waveform input without changing portable data', () => {
    expect(parseWaveInput(pulse)).toMatchObject({
      pulse,
      frames: [
        [10, 20],
        [10, 40],
      ],
    });
    expect(parseWaveInput('{"frames":[[20,30]]}')).toEqual({ frames: [[20, 30]] });
  });

  it('keeps the selected modality in downloaded waveform templates', () => {
    expect(createUploadTemplate('waveform', 'vibration')).toMatchObject({
      type: 'waveform',
      content: { modality: 'vibration' },
    });
  });

  it('normalizes manual scenario tags and required content', () => {
    const payload = buildManualUploadPayload(
      manualFields({
        type: 'scenario',
        prompt: '  场景设定  ',
        tagsText: '温柔，DG Agent 温柔',
      }),
    );

    expect(payload).toMatchObject({
      type: 'scenario',
      name: '测试',
      tags: ['DG Agent', '温柔', 'DG', 'Agent', '温柔'],
      content: { prompt: '场景设定' },
    });
  });

  it('accepts and annotates an extra-large scenario while keeping a hard safety ceiling', () => {
    const prompt = '界'.repeat(STANDARD_SCENARIO_PROMPT_LENGTH + 1);
    const payload = buildManualUploadPayload(manualFields({ type: 'scenario', prompt }));

    expect(payload).toMatchObject({
      type: 'scenario',
      content: { prompt, scale: EXTRA_LARGE_SCENARIO_SCALE },
    });
    expect(
      ScenarioContentSchema.safeParse({ prompt: '界'.repeat(MAX_SCENARIO_PROMPT_LENGTH) }).success,
    ).toBe(true);
    expect(
      ScenarioContentSchema.safeParse({ prompt: '界'.repeat(MAX_SCENARIO_PROMPT_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('normalizes multiplayer roles and prevents an inverted player range', () => {
    const payload = buildManualUploadPayload(
      manualFields({
        type: 'multi-scene',
        setting: ' 世界 ',
        playerMin: '5',
        playerMax: '2',
        aiMode: 'solo',
        roles: [
          { name: ' 主持人 ', description: ' 引导 ', aiPlayable: true },
          { name: ' ', description: 'ignored', aiPlayable: false },
        ],
      }),
    );

    expect(payload).toMatchObject({
      type: 'multi-scene',
      content: {
        setting: '世界',
        playerCount: { min: 5, max: 5 },
        aiMode: 'solo',
        roles: [{ name: '主持人', description: '引导', aiPlayable: true }],
      },
    });
  });

  it('resolves referenced pulse files in an archive and publishes unreferenced pulses', async () => {
    const archive = zipSync({
      'items.json': strToU8(
        JSON.stringify({ type: 'waveform', name: '引用条目', content: { pulse: 'wave.pulse' } }),
      ),
      'wave.pulse': strToU8(pulse),
      'extra.pulse': strToU8(pulse.replace('测试波形', '额外波形')),
      '__ignored.pulse': strToU8(pulse),
    });
    const items = await parseUploadFile(
      new File([archive], 'batch.zip', { type: 'application/zip' }),
      'vibration',
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      name: '引用条目',
      content: { pulse, modality: 'vibration' },
    });
    expect(items[1]).toMatchObject({
      name: '额外波形',
      content: { modality: 'vibration' },
    });
  });

  it.each([
    [manualFields({ type: 'scenario' }), '请填写场景提示词'],
    [manualFields({ type: 'multi-scene' }), '请填写世界观'],
    [manualFields({ type: 'multi-scene', setting: '世界' }), '至少填写一个角色'],
  ])('preserves manual validation errors', (fields, message) => {
    expect(() => buildManualUploadPayload(fields)).toThrow(message);
  });
});
