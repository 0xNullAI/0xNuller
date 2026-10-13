// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { updateDeviceSafety } from '@0xnullai/settings';
import { useSettingsManager, withModelBehavior } from './use-settings-manager';

describe('unified AI settings integration', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the session-wide allow-all mode when shared safety UI changes', async () => {
    const { result } = renderHook(() => useSettingsManager());

    act(() => {
      updateDeviceSafety((current) => ({ ...current, permissionMode: 'allow-all' }));
    });

    await waitFor(() => {
      expect(result.current.settings.permissionMode).toBe('allow-all');
      expect(result.current.settingsDraft.permissionMode).toBe('allow-all');
    });
  });

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

  it('keeps the same settings object when a behavior sync changes nothing', async () => {
    const { result } = renderHook(() => useSettingsManager());
    const before = result.current.settings;
    act(() => {
      new BrowserAppSettingsStore().saveModelBehavior({
        modelContextStrategy: before.modelContextStrategy,
        temperature: before.temperature,
      });
    });
    expect(result.current.settings).toBe(before);
    expect(withModelBehavior(before, { temperature: before.temperature })).toBe(before);
    expect(withModelBehavior(before, { temperature: before.temperature + 0.1 })).not.toBe(before);
  });
});
