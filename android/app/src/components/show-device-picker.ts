import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeviceSelectionController, DiscoveredDevice } from '@dg-kit/transport-tauri-blec';
import { DevicePicker } from './DevicePicker';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * Imperatively show the device picker modal. Subscribes to the controller's
 * live device-update stream so newly discovered devices appear in the modal
 * during scanning. Resolves with the chosen device address, or `null` on cancel.
 */
export function showDevicePicker(controller: DeviceSelectionController): Promise<string | null> {
  if (!host) {
    host = document.createElement('div');
    host.id = 'dgaa-device-picker-host';
    document.body.appendChild(host);
    root = createRoot(host);
  }

  return new Promise<string | null>((resolve) => {
    let devices: DiscoveredDevice[] = controller.initial;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeScanning: (() => void) | null = null;
    let scanning = controller.scanning;
    let didResetScroll = false;

    const render = () => {
      root!.render(
        createElement(DevicePicker, {
          open: true,
          devices,
          scanning,
          onSelect: (address: string) => close(address),
          onCancel: () => close(null),
        }),
      );
      if (!didResetScroll) {
        didResetScroll = true;
        // The host/root is reused between scans. Reset the retained scroll
        // offset after the first render so the visible first row and the
        // submitted address cannot diverge across repeated attempts.
        queueMicrotask(() => {
          host?.querySelector<HTMLElement>('.dgaa-picker-list')?.scrollTo({ top: 0 });
        });
      }
    };

    const close = (value: string | null): void => {
      unsubscribe?.();
      unsubscribeScanning?.();
      root?.render(createElement(Fragment));
      resolve(value);
    };

    unsubscribe = controller.subscribe((next) => {
      devices = next;
      render();
    });
    unsubscribeScanning = controller.subscribeScanning((next) => {
      scanning = next;
      render();
    });
    render();
  });
}
