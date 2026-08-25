import { useState, useCallback, useEffect } from 'react';
import {
  BUILTIN_WAVEFORMS,
  parseImportFile,
  marketItemToWaveform,
  type WaveformDefinition,
} from './product-library.js';
import {
  listCustomWaveforms,
  listHiddenBuiltins,
  removeCustomWaveform,
  saveCustomWaveform,
  setBuiltinHidden,
  subscribeWaveforms,
} from './index.js';
import type { MarketItem } from '@0xnullai/market-client';

/**
 * Backed by the shared library, not Chat's own localStorage.
 *
 * Chat and Agent used to keep separate stores, so a waveform designed in one
 * did not exist in the other. The shared module merges the old per-module
 * stores on first read, so nothing is lost in the switch.
 */
export function useWaveforms() {
  const [customWaveforms, setCustomWaveforms] = useState<WaveformDefinition[]>([]);
  const [hiddenBuiltinIds, setHiddenBuiltinIds] = useState<string[]>([]);

  const allWaveforms = [
    ...BUILTIN_WAVEFORMS.filter((w) => !hiddenBuiltinIds.includes(w.id)),
    ...customWaveforms,
  ];

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([listCustomWaveforms(), listHiddenBuiltins()]).then(([custom, hidden]) => {
        if (!alive) return;
        setCustomWaveforms(
          custom.map((w) => ({ ...w, description: w.description ?? '', custom: true })),
        );
        setHiddenBuiltinIds(hidden);
      });
    };
    refresh();
    const unsubscribe = subscribeWaveforms(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const importFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const waveforms = await parseImportFile(file);
      if (waveforms.length === 0) return '无法解析文件格式';
      for (const w of waveforms) await saveCustomWaveform(w);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : '导入失败';
    }
  }, []);

  const addRemoteWaveform = useCallback((waveform: WaveformDefinition) => {
    void saveCustomWaveform(waveform);
  }, []);

  // Import from the market: map to a WaveformDefinition (frames passed through as-is), dedupe by
  // the market- prefixed id, then persist.
  const addMarketWaveform = useCallback((item: MarketItem) => {
    void saveCustomWaveform(marketItemToWaveform(item));
  }, []);

  // builtin → hide it via localStorage; custom → actually delete it
  const removeWaveform = useCallback((id: string) => {
    if (BUILTIN_WAVEFORMS.some((w) => w.id === id)) void setBuiltinHidden(id, true);
    else void removeCustomWaveform(id);
  }, []);

  const restoreDefaults = useCallback(() => {
    void listHiddenBuiltins().then((ids) =>
      Promise.all(ids.map((id) => setBuiltinHidden(id, false))),
    );
  }, []);

  const getWaveform = useCallback(
    (id: string): WaveformDefinition | undefined => allWaveforms.find((w) => w.id === id),
    [allWaveforms],
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
