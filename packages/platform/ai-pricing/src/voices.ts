/**
 * Voices shared by managed read-aloud (TTS) and 猫愿语音 realtime calls. Both run on the same
 * speech provider, so one id works in both places. Voice ids are not prices and carry no
 * billing meaning; the route table still decides which resource bills them.
 */
export interface ManagedVoice {
  id: string;
  label: string;
}

export const MANAGED_VOICES: readonly ManagedVoice[] = [
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何' },
  { id: 'zh_male_m191_uranus_bigtts', label: '云舟' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '小天' },
  { id: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐' },
  { id: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女' },
  { id: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总' },
  { id: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年' },
  { id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客' },
];

export const DEFAULT_MANAGED_VOICE: string = MANAGED_VOICES[0]!.id;

/**
 * Ids saved before the speech provider changed (settings and per-character voices). They are
 * mapped when read, so stored rows never need a destructive migration.
 */
const LEGACY_VOICES: Readonly<Record<string, string>> = {
  eve: 'zh_female_vv_uranus_bigtts',
  ara: 'zh_female_xiaohe_uranus_bigtts',
  leo: 'zh_male_m191_uranus_bigtts',
  rex: 'zh_male_taocheng_uranus_bigtts',
  sal: 'zh_male_shenyeboke_uranus_bigtts',
  longanyang: 'zh_male_m191_uranus_bigtts',
};

/** A stored voice the service can speak (legacy ids mapped), or null for "use the default". */
export function managedVoiceFor(voice: unknown): string | null {
  if (typeof voice !== 'string') return null;
  const chosen = voice.trim();
  if (MANAGED_VOICES.some((entry) => entry.id === chosen)) return chosen;
  return Object.hasOwn(LEGACY_VOICES, chosen) ? LEGACY_VOICES[chosen]! : null;
}

/** The voice to use, falling back to the service default for an empty or unknown id. */
export function normalizeManagedVoice(voice: unknown): string {
  return managedVoiceFor(voice) ?? DEFAULT_MANAGED_VOICE;
}

export function managedVoiceLabel(voice: string): string {
  return MANAGED_VOICES.find((entry) => entry.id === voice)?.label ?? voice;
}
