import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { useVisibleMessageRead, type VisibleMessageRead } from './use-visible-message-read';
let callback: IntersectionObserverCallback;
let observed: Element;
let visibility = 'visible';
function show(intersecting = true) {
  act(() =>
    callback(
      [
        {
          target: observed,
          isIntersecting: intersecting,
          intersectionRatio: intersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
}
function Harness({ id = 'server-message', ack }: { id?: string; ack?: VisibleMessageRead }) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  useVisibleMessageRead(id, refs, ack);
  return (
    <div
      ref={(element) => {
        if (element) refs.current.set(id, element);
      }}
    >
      Server message
    </div>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    height: 30,
    width: 200,
  } as DOMRect);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(el: Element) {
        observed = el;
      }
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('does not read on mount/selection, waits for actual display and acknowledges once', async () => {
  const ack = vi.fn(async () => {});
  render(<Harness ack={ack} />);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ack).not.toHaveBeenCalled();
  show();
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(ack).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(ack).toHaveBeenCalledOnce();
  expect(ack).toHaveBeenCalledWith('server-message', expect.any(Function));
  show();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ack).toHaveBeenCalledOnce();
});
it('does not acknowledge hidden/background/disabled views and cancels when switched', async () => {
  const ack = vi.fn(async () => {});
  const view = render(<Harness ack={ack} />);
  visibility = 'hidden';
  show();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ack).not.toHaveBeenCalled();
  visibility = 'visible';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  view.rerender(<Harness />);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ack).not.toHaveBeenCalled();
});
it('revokes the preflight visibility guard during an in-flight authorization request', async () => {
  let visible: () => boolean = () => false;
  const ack = vi.fn(async (_id: string, guard: () => boolean) => {
    visible = guard;
  });
  const view = render(<Harness ack={ack} />);
  show();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(visible()).toBe(true);
  view.unmount();
  expect(visible()).toBe(false);
});

it('ChatPanel observes only server-confirmed messages, never optimistic messages or local notices', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const ack = vi.fn(async () => {});
  const base = {
    id: 'local',
    fromSelf: true,
    senderId: 'me',
    senderName: 'me',
    text: 'optimistic',
    timestamp: 1,
  };
  const view = render(
    <ChatPanel
      conversationId="test-room"
      messages={[base]}
      onSend={vi.fn()}
      onSendMedia={vi.fn()}
      onMessageVisible={ack}
    />,
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ack).not.toHaveBeenCalled();
  view.rerender(
    <ChatPanel
      conversationId="test-room"
      messages={[{ ...base, id: 'server', text: 'confirmed', serverConfirmed: true }, base]}
      onSend={vi.fn()}
      onSendMedia={vi.fn()}
      onMessageVisible={ack}
    />,
  );
  expect(observed.textContent).toContain('confirmed');
  show();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(ack).toHaveBeenCalledWith('server', expect.any(Function));
});
