// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { useSettingsManager } from './use-settings-manager';

describe('unified AI settings integration', () => {
  beforeEach(() => localStorage.clear());

  it('updates the live Agent settings consumed when its runtime client is composed', async () => {
    const { result } = renderHook(() => useSettingsManager());
    act(() => {
      new BrowserAppSettingsStore().saveModelBehavior({
        modelContextStrategy: 'full-history',
        temperature: 0.6,
      });
    });
    await waitFor(() => {
      expect(result.current.settings.modelContextStrategy).toBe('full-history');
      expect(result.current.settings.temperature).toBe(0.6);
    });
  });
});
