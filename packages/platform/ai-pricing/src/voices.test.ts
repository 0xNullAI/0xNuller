import { expect, it } from 'vitest';
import {
  DEFAULT_MANAGED_VOICE,
  MANAGED_VOICES,
  managedVoiceFor,
  managedVoiceLabel,
  normalizeManagedVoice,
} from './voices';

it('只接受目录中的音色，空值与未知值交给默认音色', () => {
  expect(managedVoiceFor(' zh_female_xiaohe_uranus_bigtts ')).toBe(
    'zh_female_xiaohe_uranus_bigtts',
  );
  expect(managedVoiceFor('')).toBeNull();
  expect(managedVoiceFor('alloy')).toBeNull();
  expect(managedVoiceFor(42)).toBeNull();
  expect(normalizeManagedVoice(undefined)).toBe(DEFAULT_MANAGED_VOICE);
  expect(normalizeManagedVoice('toString')).toBe(DEFAULT_MANAGED_VOICE);
});

it('旧服务商保存的音色在读取时映射到目录音色，不改写存量数据', () => {
  for (const legacy of ['eve', 'ara', 'leo', 'rex', 'sal', 'longanyang']) {
    const mapped = managedVoiceFor(legacy);
    expect(MANAGED_VOICES.some((voice) => voice.id === mapped)).toBe(true);
  }
  expect(normalizeManagedVoice('rex')).toBe('zh_male_taocheng_uranus_bigtts');
});

it('目录 ID 唯一且都有中文名', () => {
  expect(new Set(MANAGED_VOICES.map((voice) => voice.id)).size).toBe(MANAGED_VOICES.length);
  expect(managedVoiceLabel(DEFAULT_MANAGED_VOICE)).toBe('Vivi');
  expect(managedVoiceLabel('unknown')).toBe('unknown');
});
