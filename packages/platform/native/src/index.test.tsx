// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddedDeviceRuntimeProvider } from '@0xnullai/device-runtime';
import { NativeBridgeProvider, useEmbeddedDeviceRuntimeEnabled, useNativeBridge } from './index.js';

function providerHarness(initialEnabled = false) {
  let enabled = initialEnabled;
  const listeners = new Set<(value: boolean) => void>();
  const provider = {
    isEnabled: () => enabled,
    subscribeEnabled: (listener: (value: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EmbeddedDeviceRuntimeProvider;
  return {
    provider,
    publish(next: boolean) {
      enabled = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function Consumer() {
  const provider = useNativeBridge().deviceRuntime;
  const enabled = useEmbeddedDeviceRuntimeEnabled();
  return <p>{provider ? (enabled ? 'available' : 'hidden') : 'unsupported'}</p>;
}

afterEach(cleanup);

describe('useEmbeddedDeviceRuntimeEnabled', () => {
  it('distinguishes an injected provider from the single enabled setting in real time', () => {
    const runtime = providerHarness();
    render(
      <NativeBridgeProvider bridge={{ deviceRuntime: runtime.provider }} native={false}>
        <Consumer />
      </NativeBridgeProvider>,
    );

    expect(screen.getByText('hidden')).toBeTruthy();
    act(() => runtime.publish(true));
    expect(screen.getByText('available')).toBeTruthy();
    act(() => runtime.publish(false));
    expect(screen.getByText('hidden')).toBeTruthy();
  });

  it('fails closed when the shell provides no generic-device runtime', () => {
    render(
      <NativeBridgeProvider bridge={{}} native={false}>
        <Consumer />
      </NativeBridgeProvider>,
    );

    expect(screen.getByText('unsupported')).toBeTruthy();
  });
});
