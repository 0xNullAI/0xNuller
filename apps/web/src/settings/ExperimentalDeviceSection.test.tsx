import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NativeBridgeProvider } from '@0xnullai/native';
import type { EmbeddedDeviceRuntimeProvider } from '@0xnullai/device-runtime';
import { ExperimentalDeviceSection } from './ExperimentalDeviceSection';

function providerHarness() {
  let enabled = false;
  const listeners = new Set<(value: boolean) => void>();
  const setEnabled = vi.fn(async (value: boolean) => {
    enabled = value;
    for (const listener of listeners) listener(value);
  });
  const provider = {
    isEnabled: () => enabled,
    setEnabled,
    subscribeEnabled: (listener: (value: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EmbeddedDeviceRuntimeProvider;
  return { provider, setEnabled };
}

describe('ExperimentalDeviceSection', () => {
  it('changes the single shell-level local opt-in', async () => {
    const { provider, setEnabled } = providerHarness();
    render(
      <NativeBridgeProvider bridge={{ deviceRuntime: provider }} native={false}>
        <ExperimentalDeviceSection />
      </NativeBridgeProvider>,
    );

    const toggle = screen.getByRole('checkbox', { name: '启用通用设备' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it('shows a failed update without pretending the setting changed', async () => {
    const provider = {
      isEnabled: () => false,
      setEnabled: vi.fn(async () => {
        throw new Error('停止确认失败');
      }),
      subscribeEnabled: () => () => undefined,
    } as unknown as EmbeddedDeviceRuntimeProvider;
    render(
      <NativeBridgeProvider bridge={{ deviceRuntime: provider }} native={false}>
        <ExperimentalDeviceSection />
      </NativeBridgeProvider>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: '启用通用设备' }));
    expect((await screen.findByRole('alert')).textContent).toContain('停止确认失败');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});
