export { startWaveformId } from '@dg-kit/core';

/** How long each queued waveform plays before the next one, as offered in the player. */
export const PLAY_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: '10秒' },
  { value: 20, label: '20秒' },
  { value: 30, label: '30秒' },
  { value: 60, label: '1分钟' },
  { value: 120, label: '2分钟' },
  { value: 300, label: '5分钟' },
  { value: 600, label: '10分钟' },
];
