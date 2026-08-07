import { useState, useCallback, useEffect } from 'react';
import {
  BUILTIN_WAVEFORMS,
  loadCustomWaveforms,
  saveCustomWaveforms,
  parseImportFile,
  marketItemToWaveform,
  type WaveformDefinition,
} from '../lib/waveforms';
import type { MarketItem } from '../lib/market';

const HIDDEN_KEY = 'dg-chat-hidden-builtins';

function loadHiddenBuiltins(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

export function useWaveforms() {
  const [customWaveforms, setCustomWaveforms] = useState<WaveformDefinition[]>(() => loadCustomWaveforms());
  const [hiddenBuiltinIds, setHiddenBuiltinIds] = useState<string[]>(() => loadHiddenBuiltins());

  const allWaveforms = [
    ...BUILTIN_WAVEFORMS.filter(w => !hiddenBuiltinIds.includes(w.id)),
    ...customWaveforms,
  ];

  useEffect(() => { saveCustomWaveforms(customWaveforms); }, [customWaveforms]);
  useEffect(() => { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenBuiltinIds)); }, [hiddenBuiltinIds]);

  const importFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const waveforms = await parseImportFile(file);
      if (waveforms.length === 0) return '无法解析文件格式';
      setCustomWaveforms(prev => [...prev, ...waveforms]);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : '导入失败';
    }
  }, []);

  const addRemoteWaveform = useCallback((waveform: WaveformDefinition) => {
    setCustomWaveforms(prev => prev.some(w => w.id === waveform.id) ? prev : [...prev, { ...waveform, custom: true }]);
  }, []);

  // 从市场导入：映射成 WaveformDefinition（frames 原样透传），按 market- 前缀 id 去重后持久化。
  const addMarketWaveform = useCallback((item: MarketItem) => {
    const waveform = marketItemToWaveform(item);
    setCustomWaveforms(prev => prev.some(w => w.id === waveform.id) ? prev : [...prev, waveform]);
  }, []);

  // builtin → 隐藏到 localStorage；custom → 真删
  const removeWaveform = useCallback((id: string) => {
    if (BUILTIN_WAVEFORMS.some(w => w.id === id)) {
      setHiddenBuiltinIds(prev => prev.includes(id) ? prev : [...prev, id]);
    } else {
      setCustomWaveforms(prev => prev.filter(w => w.id !== id));
    }
  }, []);

  const restoreDefaults = useCallback(() => {
    setCustomWaveforms([]);
    setHiddenBuiltinIds([]);
  }, []);

  const getWaveform = useCallback(
    (id: string): WaveformDefinition | undefined => allWaveforms.find(w => w.id === id),
    [allWaveforms]
  );

  return {
    allWaveforms,
    customWaveforms,
    importFile,
    addRemoteWaveform,
    addMarketWaveform,
    removeWaveform,
    restoreDefaults,
    getWaveform,
  };
}
