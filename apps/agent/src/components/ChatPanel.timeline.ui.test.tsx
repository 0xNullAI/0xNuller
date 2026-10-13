// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createEmptyDeviceState, createEmptySensorState } from '@dg-agent/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import type { PrivateConversationAttachment } from '@0xnullai/auth';
import { ShellChromeProvider } from '@0xnullai/ui';
import { buildRenderableTimeline, ChatPanel } from './ChatPanel.js';

const avatarRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./AssistantAvatar.js', () => ({
  AssistantAvatar: () => {
    avatarRenders.count += 1;
    return null;
  },
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => null,
  subscribeAuthChanges: () => () => undefined,
  listMediaJobs: vi.fn(),
  mediaJobBlob: vi.fn(),
  PrivateConversationAttachmentChannel: class {
    list = vi.fn().mockResolvedValue([]);
    dispose = vi.fn();
  },
  PrivateConversationChannel: class {
    dispose = vi.fn();
  },
}));

afterEach(cleanup);

const identity = { accountId: 'alice', conversationId: 's', agentId: 'c', agentName: 'AI' };
const message = (id: string, createdAt: number, role: 'user' | 'assistant' = 'assistant') => ({
  id,
  role,
  content: id,
  createdAt,
});
const attachment = (id: string, messageId: string, createdAt: number) =>
  ({ id, messageId, createdAt, kind: 'image' }) as unknown as PrivateConversationAttachment;

it('draws only the attachments of the loaded message window', () => {
  const messages = [message('m10', 10), message('m11', 11)];
  const attachments = [attachment('old', 'm1', 1), attachment('own', 'm11', 11)];
  const ids = (hasOlder: boolean) =>
    buildRenderableTimeline(identity, messages, [], [], attachments, hasOlder).map(
      (item) => item.id,
    );
  // Older pages remain: the attachment of an unloaded message is not piled on top.
  expect(ids(true)).toEqual(['m10', 'attachment:own']);
  // The whole history is loaded: every attachment has its place.
  expect(ids(false)).toEqual(['attachment:old', 'm10', 'attachment:own']);
});

it('places extras after the last message not newer than them, in server order', () => {
  // Server order wins over a skewed client clock (m2 is older by clock but later in order).
  const messages = [message('m1', 10), message('m2', 5), message('m3', 30)];
  const trace = [
    { id: 't1', text: 'a', createdAt: 7 },
    { id: 't2', text: 'b', createdAt: 20 },
    { id: 't0', text: 'c', createdAt: 1 },
  ];
  expect(buildRenderableTimeline(identity, messages, trace, [], []).map((item) => item.id)).toEqual(
    ['trace-feed:t0', 'm1', 'm2', 'trace-feed:t1', 'trace-feed:t2', 'm3'],
  );
});

function props(text: string): ComponentProps<typeof ChatPanel> {
  return {
    accountId: null,
    activeSessionId: 's',
    text,
    statusMessage: null,
    onTextChange: () => undefined,
    onAbortReply: () => undefined,
    onToggleVoiceMode: () => undefined,
    onSend: () => undefined,
    onAskImage: () => undefined,
    imageInputSupported: false,
    busy: false,
    speechRecognitionEnabled: false,
    voiceMode: false,
    voiceState: 'idle',
    speechRecognitionSupported: false,
    session: SESSION,
    onLoadEarlier: async () => undefined,
    observedSequence: null,
    onTranscriptTailVisibilityChange: () => undefined,
    traceFeed: NO_TRACE,
    streamingAssistantText: '',
    deviceState: createEmptyDeviceState(),
    maxStrengthA: 10,
    maxStrengthB: 10,
    opossumState: createEmptyOpossumState(),
    maxOpossumIntensityA: 10,
    maxOpossumIntensityB: 10,
    pawPrintsState: createEmptySensorState(),
    civetEdgingState: createEmptySensorState(),
    onConnect: () => undefined,
    onEmergencyStop: () => undefined,
    onOpenSidebar: () => undefined,
    onOpenSettings: () => undefined,
    promptPresetId: 'c',
    savedPresets: NO_PRESETS,
    coyoteTargets: [],
    activeCoyoteId: null,
    onCoyoteTargetChange: () => undefined,
  };
}
// The parent keeps these by identity (session state, live trace state, scene library).
const SESSION = {
  id: 's',
  createdAt: 1,
  updatedAt: 1,
  messages: [message('a1', 1), message('a2', 2), message('a3', 3)],
  deviceState: createEmptyDeviceState(),
};
const NO_TRACE: ComponentProps<typeof ChatPanel>['traceFeed'] = [];
const NO_PRESETS: ComponentProps<typeof ChatPanel>['savedPresets'] = [];

it('typing re-renders the composer, not every message row', () => {
  const panel = (text: string) => (
    <ShellChromeProvider openSettings={() => undefined} signedIn>
      <ChatPanel {...props(text)} />
    </ShellChromeProvider>
  );
  const view = render(panel(''));
  const afterMount = avatarRenders.count;
  expect(afterMount).toBeGreaterThan(0);
  // Fresh inline callbacks and new text, as the parent passes on every keystroke.
  view.rerender(panel('h'));
  view.rerender(panel('hi'));
  expect(avatarRenders.count).toBe(afterMount);
});
