import type { DeviceKind, WaveformDefinition, WaveformModality } from './index.js';

/** Legacy waveform records predate modalities and are electrostimulation waves. */
export const DEFAULT_WAVEFORM_MODALITY: WaveformModality = 'electrostimulation';

/** Normalize legacy definitions before applying device-family rules. */
export function getWaveformModality(
  waveform: Pick<WaveformDefinition, 'modality'>,
): WaveformModality {
  return waveform.modality ?? DEFAULT_WAVEFORM_MODALITY;
}

/** The wire/UI playback modes shared by Chat and the direct Control module. */
export type PlayMode = 'single' | 'list' | 'random';

export const DEFAULT_PLAY_INTERVAL_SEC = 30;

/** Pure queue operation used by every module that presents A/B playlists. */
export function toggleQueueEntry(queue: string[], id: string): string[] {
  return queue.includes(id) ? queue.filter((entry) => entry !== id) : [...queue, id];
}

/** Resolve a persisted index safely after queue edits. */
export function startWaveformId(queue: string[], index: number): string | null {
  if (queue.length === 0) return null;
  const safe = ((index % queue.length) + queue.length) % queue.length;
  return queue[safe] ?? null;
}

/** Whether a waveform can be offered by an output device of this kind. */
export function isWaveformCompatibleWithDevice(
  kind: DeviceKind,
  waveform: Pick<WaveformDefinition, 'modality'>,
): boolean {
  if (kind === 'coyote') return getWaveformModality(waveform) === 'electrostimulation';
  if (kind === 'opossum') return getWaveformModality(waveform) === 'vibration';
  return false;
}
