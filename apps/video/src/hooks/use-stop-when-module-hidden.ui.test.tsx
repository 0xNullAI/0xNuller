import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ShellChromeProvider } from '@0xnullai/ui';
import { useStopWhenModuleHidden } from './use-stop-when-module-hidden.js';

afterEach(cleanup);

function Probe({ stop }: { stop: () => void }) {
  useStopWhenModuleHidden(stop);
  return null;
}

function inShell(active: boolean, stop: () => void) {
  return (
    <ShellChromeProvider openSettings={() => undefined} signedIn active={active}>
      <Probe stop={stop} />
    </ShellChromeProvider>
  );
}

it('stops the camera and capture as soon as the shell hides Video', () => {
  const stop = vi.fn();
  const view = render(inShell(true, stop));
  // Re-renders while visible (new stop callbacks every render) do not stop anything.
  view.rerender(inShell(true, stop));
  expect(stop).not.toHaveBeenCalled();

  view.rerender(inShell(false, stop));
  expect(stop).toHaveBeenCalledOnce();

  // Coming back does not start anything on its own.
  view.rerender(inShell(true, stop));
  expect(stop).toHaveBeenCalledOnce();
});

it('uses the latest stop callback', () => {
  const first = vi.fn();
  const latest = vi.fn();
  const view = render(inShell(true, first));
  view.rerender(inShell(true, latest));
  view.rerender(inShell(false, latest));
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});

it('never fires for a standalone Video, which has no shell to hide it', () => {
  const stop = vi.fn();
  const view = render(<Probe stop={stop} />);
  view.rerender(<Probe stop={stop} />);
  expect(stop).not.toHaveBeenCalled();
});
