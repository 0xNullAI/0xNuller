import { describe, expect, it } from 'vitest';
import example from './example-price-table.json';
import {
  imageCredits,
  parsePriceTable,
  realtimeCredits,
  realtimeReservation,
  recognitionCredits,
  synthesisCredits,
  tokenCredits,
  tokenReservation,
} from './index';

describe('托管 AI 价格表', () => {
  it('解析完整价格表，字符串与对象都接受', () => {
    expect(parsePriceTable(example)?.chat.model).toBe('example-chat-model');
    expect(parsePriceTable(JSON.stringify(example))?.version).toBe('example-1');
  });

  it('缺项、负价、非法模型 ID 一律拒绝，能力随之关闭', () => {
    expect(parsePriceTable(undefined)).toBeNull();
    expect(parsePriceTable('{not json')).toBeNull();
    expect(parsePriceTable({ ...example, image: undefined })).toBeNull();
    expect(
      parsePriceTable({ ...example, chat: { ...example.chat, outputPerMillion: -1 } }),
    ).toBeNull();
    expect(
      parsePriceTable({ ...example, chat: { ...example.chat, model: 'bad model' } }),
    ).toBeNull();
  });

  it('按实际 usage 计费：缓存部分按缓存价，向上取整且至少 1', () => {
    const table = parsePriceTable(example)!;
    expect(
      tokenCredits(table.chat, {
        prompt_tokens: 10_000,
        completion_tokens: 1_000,
        prompt_tokens_details: { cached_tokens: 8_000 },
      }),
    ).toBe(Math.ceil((2_000 * 100 + 8_000 * 10 + 1_000 * 400) / 1_000_000));
    expect(tokenCredits(table.chat, {})).toBe(1);
    // A provider reporting more cached than prompt tokens cannot make the call cheaper.
    expect(
      tokenCredits(table.chat, {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 900 },
      }),
    ).toBe(1);
  });

  it('预留按全部未命中缓存与最大输出估算，不低于实际结算', () => {
    const table = parsePriceTable(example)!;
    const reserved = tokenReservation(table.chat, 50_000, 4_096);
    const charged = tokenCredits(table.chat, {
      prompt_tokens: 50_000,
      completion_tokens: 4_096,
      prompt_tokens_details: { cached_tokens: 40_000 },
    });
    expect(reserved).toBeGreaterThanOrEqual(charged);
  });

  it('图片、朗读、识别与实时语音按各自单位计费', () => {
    const table = parsePriceTable(example)!;
    expect(imageCredits(table.image, 2)).toBe(40);
    expect(synthesisCredits(table.tts, 8)).toBe(1);
    expect(synthesisCredits(table.tts, 20_000)).toBe(100);
    expect(recognitionCredits(table.asr, 3_600_000)).toBe(100);
    expect(recognitionCredits(table.asr, 1)).toBe(1);
    expect(
      realtimeCredits(table.realtime, { inputAudioTokens: 1_000_000, outputAudioTokens: 500_000 }),
    ).toBe(1_000 + 2_000);
  });

  it('实时语音缓存命中单独上报：未配置缓存价时按输入价计，配置后按缓存价计', () => {
    const table = parsePriceTable(example)!;
    const usage = { inputTextTokens: 1_000_000, cachedTextTokens: 1_000_000 };
    expect(realtimeCredits(table.realtime, usage)).toBe(100 + 100);
    const cached = parsePriceTable({
      ...example,
      realtime: { ...example.realtime, cachedInputTextPerMillion: 10 },
    })!;
    expect(realtimeCredits(cached.realtime, usage)).toBe(100 + 10);
    expect(
      parsePriceTable({
        ...example,
        realtime: { ...example.realtime, cachedInputAudioPerMillion: -1 },
      }),
    ).toBeNull();
    expect(realtimeCredits(table.realtime, {})).toBe(0);
  });

  it('实时语音预留随时长增长且至少 1', () => {
    const table = parsePriceTable(example)!;
    expect(realtimeReservation(table.realtime, 0)).toBe(1);
    expect(realtimeReservation(table.realtime, 2)).toBeGreaterThan(
      realtimeReservation(table.realtime, 1),
    );
  });
});
