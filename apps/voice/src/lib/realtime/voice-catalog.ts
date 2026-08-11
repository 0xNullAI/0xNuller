/**
 * xAI is the one provider in the catalog whose voice list is meant to be
 * fetched at runtime (`voiceSource: 'api'` in `providers.ts`) rather than
 * hardcoded — the plan this was scaffolded from called out that xAI ships
 * far more voices than the handful of legacy names (`ara`/`eve`/`leo`/`rex`/
 * `sal`) that show up in older docs, and the only way to get the current
 * list right is to ask the API. NOT LIVE-VERIFIED: the exact response shape
 * is unconfirmed (no API key was available while writing this), so
 * `extractVoiceIds` defensively accepts a few plausible shapes rather than
 * assuming one.
 */
export async function fetchXaiVoices(apiKey: string): Promise<string[]> {
  const response = await fetch(applyHttpProxy('https://api.x.ai/v1/tts/voices'), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`获取音色列表失败（HTTP ${response.status}）`);
  }
  const data: unknown = await response.json();
  const voices = extractVoiceIds(data);
  if (voices.length === 0) {
    throw new Error('音色列表为空或格式无法识别');
  }
  return voices;
}

function extractVoiceIds(data: unknown): string[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.voices)
      ? data.voices
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : [];

  return list
    .map((item): string | undefined => {
      if (typeof item === 'string') return item;
      if (isRecord(item)) {
        const id = item.voice_id ?? item.id ?? item.name;
        return typeof id === 'string' ? id : undefined;
      }
      return undefined;
    })
    .filter((id): id is string => Boolean(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
import { applyHttpProxy } from '@0xnullai/settings';
