import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { registerSafetySession } from '@dg-kit/safety';
import { OverlayStopAnchor } from './overlay-stop-anchor';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { PermissionModal } from './permission-modal';
import { openModalCount } from '../modal-presence';
import { clearStopFailure, stopFailureLabels } from '../stop-all';

const unregister: (() => void)[] = [];

function connectDevice(stop: () => void | Promise<void> = vi.fn()) {
  unregister.push(
    registerSafetySession({
      id: 'test-module',
      label: '测试模块',
      isActive: () => true,
      stop,
      devices: () => [
        { id: 'coyote-1', kind: 'coyote', name: 'Coyote', connected: true, active: true },
      ],
    }),
  );
  return stop;
}

afterEach(() => {
  cleanup();
  for (const off of unregister.splice(0)) off();
  clearStopFailure();
});

describe('OverlayStopAnchor', () => {
  it('stays out of the way while no modal covers the device bar', () => {
    connectDevice();
    render(<OverlayStopAnchor />);
    expect(screen.queryByRole('button', { name: /停止设备/ })).toBeNull();
  });

  it('stops every device from above an open modal dialog without closing it', async () => {
    const stop = connectDevice();
    const onOpenChange = vi.fn();
    render(
      <>
        <OverlayStopAnchor />
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>设置</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );

    const button = await screen.findByRole('button', { name: /停止设备/ });
    // Radix locks the page behind a modal; the anchor must opt back in and must not
    // have been hidden from assistive tech with the rest of the page.
    await waitFor(() => expect(document.body.style.pointerEvents).toBe('none'));
    expect(button.style.pointerEvents).toBe('auto');
    expect(button.style.zIndex).toBe('var(--z-stop)');
    expect(button.closest('[aria-hidden="true"]')).toBeNull();

    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button);
    fireEvent.click(button);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('rises above the permission prompt, which has no stop of its own', async () => {
    const stop = connectDevice();
    render(
      <>
        <OverlayStopAnchor />
        <PermissionModal
          summary="A 通道 30"
          args={{}}
          onAllowOnce={vi.fn()}
          onAllowTimed={vi.fn()}
          onAllowSession={vi.fn()}
          onDeny={vi.fn()}
        />
      </>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /停止设备/ }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('reports a stop that did not take through the shared failure store', async () => {
    connectDevice(() => {
      throw new Error('ble gone');
    });
    render(
      <>
        <OverlayStopAnchor />
        <PermissionModal
          summary="A 通道 30"
          args={{}}
          onAllowOnce={vi.fn()}
          onAllowTimed={vi.fn()}
          onAllowSession={vi.fn()}
          onDeny={vi.fn()}
        />
      </>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /停止设备/ }));
    await waitFor(() => expect(stopFailureLabels()).toEqual(['测试模块']));
  });

  it('does not appear over a modal when no device is connected', () => {
    render(
      <>
        <OverlayStopAnchor />
        <PermissionModal
          summary="A 通道 30"
          args={{}}
          onAllowOnce={vi.fn()}
          onAllowTimed={vi.fn()}
          onAllowSession={vi.fn()}
          onDeny={vi.fn()}
        />
      </>,
    );
    expect(screen.queryByRole('button', { name: /停止设备/ })).toBeNull();
  });

  it('counts stacked modals and releases each one on close', () => {
    expect(openModalCount()).toBe(0);
    const view = render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>外层</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(openModalCount()).toBe(1);
    act(() => view.unmount());
    expect(openModalCount()).toBe(0);
  });
});
