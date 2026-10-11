import type * as VoiceToolBridgeModuleValue from '@voice/lib/realtime/voice-tool-bridge';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createEmptyDeviceState } from '@dg-kit/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceSession, DeviceSessionState } from '@voice/lib/device-session';
import { createDefaultSettings, type VoiceSettings } from '@voice/lib/settings';
import type { RealtimeSession, RealtimeSessionOptions } from '@voice/lib/realtime/realtime-session';
import type { SceneLibrary } from '@0xnullai/scenes';
import { useRealtimeCall } from './use-realtime-call';

const historyMocks = vi.hoisted(() => ({
  account: 'alice',
  selection: null as { characterId: string } | null,
  listeners: new Set<() => void>(),
  append: vi.fn(async () => ({})),
  prepare: vi.fn(),
  open: vi.fn(),
}));
const sceneMocks = vi.hoisted(() => ({
  loadScenes: vi.fn<() => SceneLibrary>(() => ({
    selectedId: 'gentle',
    scenes: [{ id: 'gentle', name: '温柔陪伴', prompt: '温柔', kind: 'character' }],
    hiddenBuiltinIds: [],
  })),
}));
vi.mock('@0xnullai/scenes', async (importOriginal) => ({
  ...(await importOriginal()),
  loadScenes: sceneMocks.loadScenes,
}));
historyMocks.prepare.mockImplementation(async () => ({
  context: 'private recent context',
  channel: {
    selection: { conversationId: 'voice-conversation', accountId: 'alice' },
    append: historyMocks.append,
    dispose: vi.fn(),
    assertCurrent: vi.fn(),
  },
}));
vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  currentAuthUserId: () => historyMocks.account,
  readPrivateConversationSelection: () => historyMocks.selection,
  subscribeAuthChanges: (listener: () => void) => {
    historyMocks.listeners.add(listener);
    return () => historyMocks.listeners.delete(listener);
  },
  preparePrivateConversation: historyMocks.prepare,
  openPrivateConversationChannel: historyMocks.open,
}));

type VoiceToolBridgeModule = typeof VoiceToolBridgeModuleValue;
const realtimeMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
const bridgeMocks = vi.hoisted(() => ({
  onReceipt: null as null | ((receipt: unknown) => void),
}));
vi.mock('@voice/lib/realtime/voice-tool-bridge', async (importOriginal) => {
  const original = await importOriginal<VoiceToolBridgeModule>();
  class RecordingBridge extends original.VoiceToolBridge {
    constructor(...args: ConstructorParameters<typeof original.VoiceToolBridge>) {
      super(...args);
      bridgeMocks.onReceipt = args[2] as (receipt: unknown) => void;
    }
  }
  return { ...original, VoiceToolBridge: RecordingBridge };
});
vi.mock('@voice/lib/realtime/realtime-session', async (importOriginal) => ({
  ...(await importOriginal()),
  createRealtimeSession: realtimeMocks.createSession,
}));

afterEach(() => {
  vi.useRealTimers();
  realtimeMocks.createSession.mockReset();
  historyMocks.append.mockClear();
  historyMocks.account = 'alice';
  historyMocks.selection = null;
  historyMocks.prepare.mockClear();
  historyMocks.open.mockReset();
  sceneMocks.loadScenes.mockReset().mockReturnValue({
    selectedId: 'gentle',
    scenes: [{ id: 'gentle', name: '温柔陪伴', prompt: '温柔', kind: 'character' }],
    hiddenBuiltinIds: [],
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function minimalDeviceSession(emergencyStop = vi.fn(async () => undefined)): DeviceSession {
  const state: DeviceSessionState = {
    coyotes: [],
    coyote: createEmptyDeviceState(),
    opossum: createEmptyOpossumState(),
  };
  return {
    coyote: {},
    opossum: {},
    getState: vi.fn(async () => state),
    listCoyoteTargets: vi.fn(async () => []),
    onChanged: vi.fn(() => vi.fn()),
    emergencyStop,
  } as unknown as DeviceSession;
}

function realtimeSession(connect: () => Promise<void>): RealtimeSession {
  return {
    connect: vi.fn(connect),
    disconnect: vi.fn(),
    updateConfiguration: vi.fn(),
    updateInstructions: vi.fn(),
    isConnected: () => true,
    sendFunctionCallOutput: vi.fn(),
    requestResponse: vi.fn(),
    whenAudioDrained: vi.fn(async () => undefined),
  };
}

describe('useRealtimeCall 正常结束', () => {
  it('模块切换的内部原因不会显示成红色服务错误', async () => {
    const emergencyStop = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useRealtimeCall({ emergencyStop } as unknown as DeviceSession, {} as VoiceSettings),
    );

    await act(async () => {
      await result.current.hangUp('切换到其他模块');
    });

    expect(emergencyStop).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('ended');
    expect(result.current.state.error).toBeNull();
  });

  it('updates the model tool allowlist on topology changes without reconnecting', async () => {
    let state: DeviceSessionState = {
      coyotes: [],
      coyote: createEmptyDeviceState(),
      opossum: createEmptyOpossumState(),
    };
    let changed: () => void = () => undefined;
    const deviceSession = {
      coyote: {},
      opossum: {},
      getState: vi.fn(async () => state),
      listCoyoteTargets: vi.fn(async () => state.coyotes),
      onChanged: vi.fn((listener: () => void) => {
        changed = listener;
        return vi.fn();
      }),
      emergencyStop: vi.fn(async () => undefined),
    } as unknown as DeviceSession;
    const updateConfiguration = vi.fn();
    const realtimeSession = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      updateConfiguration,
      updateInstructions: vi.fn(),
      isConnected: () => true,
      sendFunctionCallOutput: vi.fn(),
      requestResponse: vi.fn(),
      whenAudioDrained: vi.fn(async () => undefined),
    } satisfies RealtimeSession;
    realtimeMocks.createSession.mockResolvedValue(realtimeSession);
    const settings = createDefaultSettings();
    settings.activeProviderId = 'xai';
    settings.providers.xai.apiKey = 'test-key';

    const { result } = renderHook(() => useRealtimeCall(deviceSession, settings));
    await act(async () => result.current.startCall());

    const initial = realtimeMocks.createSession.mock.calls[0]?.[0] as RealtimeSessionOptions;
    expect(initial.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['shock_start', 'vibrate_start']),
    );

    const connectedCoyote = { ...state.coyote, connected: true };
    state = {
      ...state,
      coyotes: [{ targetId: 'coyote/opaque-1', state: connectedCoyote }],
      coyote: connectedCoyote,
    };
    act(() => changed());
    await waitFor(() =>
      expect(updateConfiguration).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: 'shock_start' })]),
        }),
      ),
    );
    const connectedUpdate = updateConfiguration.mock.calls.at(-1)?.[0] as {
      tools: Array<{ name: string }>;
    };
    expect(connectedUpdate.tools.map((tool) => tool.name)).not.toContain('vibrate_start');

    state = {
      ...state,
      coyotes: [...state.coyotes, { targetId: 'coyote/opaque-2', state: { ...connectedCoyote } }],
    };
    act(() => changed());
    await waitFor(() => {
      const latest = updateConfiguration.mock.calls.at(-1)?.[0] as {
        instructions: string;
        tools: Array<{
          name: string;
          parameters: { properties?: { targetId?: { enum?: string[] } } };
        }>;
      };
      const shockStart = latest.tools.find((tool) => tool.name === 'shock_start');
      expect(shockStart?.parameters.properties?.targetId?.enum).toEqual([
        'coyote/opaque-1',
        'coyote/opaque-2',
      ]);
      expect(latest.instructions).toContain('coyote/opaque-2');
    });

    state = {
      ...state,
      coyotes: [],
      coyote: { ...state.coyote, connected: false },
    };
    act(() => changed());
    await waitFor(() => {
      const latest = updateConfiguration.mock.calls.at(-1)?.[0] as {
        tools: Array<{ name: string }>;
      };
      expect(latest.tools.map((tool) => tool.name)).not.toContain('shock_start');
    });
    const disconnectedUpdate = updateConfiguration.mock.calls.at(-1)?.[0] as {
      instructions: string;
      tools: Array<{ name: string }>;
    };
    expect(disconnectedUpdate.instructions).not.toContain('郊狼');
    expect(disconnectedUpdate.tools.map((tool) => tool.name)).not.toContain('shock_start');
    expect(realtimeMocks.createSession).toHaveBeenCalledTimes(1);
    expect(realtimeSession.disconnect).not.toHaveBeenCalled();
  }, 10_000);

  it('performs the complete hangup path when the remote session closes', async () => {
    const emergencyStop = vi.fn(async () => undefined);
    const deviceSession = minimalDeviceSession(emergencyStop);
    const session = realtimeSession(async () => undefined);
    realtimeMocks.createSession.mockResolvedValue(session);
    const settings = createDefaultSettings();
    settings.activeProviderId = 'xai';
    settings.providers.xai.apiKey = 'test-key';
    const { result } = renderHook(() => useRealtimeCall(deviceSession, settings));

    await act(async () => result.current.startCall());
    const options = realtimeMocks.createSession.mock.calls[0]?.[0] as RealtimeSessionOptions;
    act(() => options.events.onClose?.('remote closed'));

    await waitFor(() => expect(emergencyStop).toHaveBeenCalledOnce());
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(result.current.state).toMatchObject({ status: 'ended', error: 'remote closed' });
  });

  it('disconnects a session whose connection completes after the user cancelled', async () => {
    const connecting = deferred<undefined>();
    const deviceSession = minimalDeviceSession();
    const session = realtimeSession(() => connecting.promise);
    realtimeMocks.createSession.mockResolvedValue(session);
    const settings = createDefaultSettings();
    settings.activeProviderId = 'xai';
    settings.providers.xai.apiKey = 'test-key';
    const { result } = renderHook(() => useRealtimeCall(deviceSession, settings));

    let start!: Promise<void>;
    act(() => {
      start = result.current.startCall();
    });
    await waitFor(() => expect(session.connect).toHaveBeenCalledOnce());
    await act(async () => result.current.hangUp());
    connecting.resolve(undefined);
    await act(async () => start);

    expect(session.disconnect).toHaveBeenCalled();
    expect(result.current.state.status).toBe('ended');
  });
});

it('extends the same private context, saves only final subtitles, and stops on an account change', async () => {
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  const session = realtimeSession(async () => undefined);
  realtimeMocks.createSession.mockResolvedValue(session);
  const { result, unmount } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  const options = realtimeMocks.createSession.mock.calls[0]![0] as RealtimeSessionOptions;
  expect(options.instructions).toContain('private recent context');
  expect(options.billingContext).toEqual({
    conversationId: 'voice-conversation',
    runId: expect.any(String),
  });
  act(() =>
    options.events.onTranscript?.({ id: 'item', role: 'assistant', text: '正在说', done: false }),
  );
  expect(historyMocks.append).not.toHaveBeenCalled();
  act(() =>
    options.events.onTranscript?.({ id: 'item', role: 'assistant', text: '完成', done: true }),
  );
  await waitFor(() => expect(historyMocks.append).toHaveBeenCalledTimes(1));
  await act(async () => {
    historyMocks.account = 'bob';
    for (const listener of historyMocks.listeners) listener();
  });
  expect(session.disconnect).toHaveBeenCalled();
  expect(result.current.state.transcript).toEqual([]);
  act(() =>
    options.events.onTranscript?.({
      id: 'late',
      role: 'assistant',
      text: '旧账户内容',
      done: true,
    }),
  );
  expect(historyMocks.append).toHaveBeenCalledTimes(1);
  unmount();
});

it('keeps failed final subtitles on the call page until a server retry succeeds', async () => {
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  historyMocks.append
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockResolvedValue({});
  realtimeMocks.createSession.mockResolvedValue(realtimeSession(async () => undefined));
  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  const options = realtimeMocks.createSession.mock.calls[0]![0] as RealtimeSessionOptions;
  act(() =>
    options.events.onTranscript?.({ id: 'final', role: 'user', text: '记住这句话', done: true }),
  );
  await waitFor(() => expect(result.current.state.historyError).toContain('offline'));
  await act(async () => result.current.hangUp());
  let saved = false;
  await act(async () => {
    saved = await result.current.retryHistory();
  });
  expect(saved).toBe(false);
  expect(result.current.state.historyError).toContain('still offline');
  await act(async () => {
    saved = await result.current.retryHistory();
  });
  expect(saved).toBe(true);
  expect(result.current.state.historyError).toBeNull();
  expect(historyMocks.append).toHaveBeenCalledTimes(3);
  expect(historyMocks.append.mock.calls[0]).toEqual(historyMocks.append.mock.calls[1]);
});

it('warns on reload only while a final subtitle has no server acknowledgement', async () => {
  const pending = deferred<object>();
  historyMocks.append.mockReturnValueOnce(pending.promise);
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  realtimeMocks.createSession.mockResolvedValue(realtimeSession(async () => undefined));
  const { result, unmount } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  const leaving = () => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(leaving()).toBe(false);
  await act(async () => result.current.startCall());
  const options = realtimeMocks.createSession.mock.calls[0]![0] as RealtimeSessionOptions;
  act(() =>
    options.events.onTranscript?.({ id: 'final', role: 'user', text: '记住这句话', done: true }),
  );
  expect(leaving()).toBe(true);
  await waitFor(() => expect(historyMocks.append).toHaveBeenCalledOnce());
  expect(leaving()).toBe(true);
  await act(async () => pending.resolve({}));
  await waitFor(() => expect(leaving()).toBe(false));
  unmount();
});

it('keeps the Agent conversation character and layers its server-bound scene', async () => {
  historyMocks.selection = { characterId: 'friend' };
  sceneMocks.loadScenes.mockReturnValueOnce({
    selectedId: 'other-scene',
    scenes: [
      { id: 'friend', name: '朋友', prompt: '朋友的人设', kind: 'character' },
      { id: 'rain', name: '雨夜', prompt: '窗外下雨', kind: 'scene' },
      { id: 'other-scene', name: '海边', prompt: '海风', kind: 'scene' },
    ],
    hiddenBuiltinIds: [],
  });
  historyMocks.prepare.mockResolvedValueOnce({
    context: '同一关系的私人记忆',
    sceneId: 'rain',
    channel: {
      selection: { conversationId: 'agent-conversation', accountId: 'alice', relationshipId: 'r' },
      append: historyMocks.append,
      dispose: vi.fn(),
      assertCurrent: vi.fn(),
    },
  });
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  realtimeMocks.createSession.mockResolvedValue(realtimeSession(async () => undefined));

  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());

  const options = realtimeMocks.createSession.mock.calls[0]![0] as RealtimeSessionOptions;
  expect(historyMocks.prepare).toHaveBeenCalledWith('friend');
  expect(options.instructions).toContain('朋友的人设');
  expect(options.instructions).toContain('窗外下雨');
  expect(options.instructions).toContain('同一关系的私人记忆');
  expect(options.instructions).not.toContain('海风');
  expect(options.billingContext?.conversationId).toBe('agent-conversation');
  expect(options.tools.map((tool) => tool.name)).toContain('memory_search');
});

it('refuses a missing server-bound scene before opening the microphone', async () => {
  const dispose = vi.fn();
  historyMocks.selection = { characterId: 'friend' };
  sceneMocks.loadScenes.mockReturnValueOnce({
    selectedId: 'friend',
    scenes: [{ id: 'friend', name: '朋友', prompt: '朋友的人设', kind: 'character' }],
    hiddenBuiltinIds: [],
  });
  historyMocks.prepare.mockResolvedValueOnce({
    context: '私人记忆',
    sceneId: 'missing',
    channel: { selection: { conversationId: 'agent-conversation' }, dispose },
  });
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';

  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());

  expect(dispose).toHaveBeenCalledOnce();
  expect(realtimeMocks.createSession).not.toHaveBeenCalled();
  expect(result.current.state.error).toContain('场景尚未在当前账户导入');
});
it('fails before opening the microphone when account conversation preparation fails', async () => {
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  historyMocks.prepare.mockRejectedValueOnce(new Error('请先登录'));
  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  expect(realtimeMocks.createSession).not.toHaveBeenCalled();
  expect(result.current.state.error).toBe('请先登录');
});

it('does not start a new voice conversation from a removed built-in default', async () => {
  sceneMocks.loadScenes.mockReturnValueOnce({
    selectedId: 'gentle',
    scenes: [],
    hiddenBuiltinIds: [],
  });
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  expect(historyMocks.prepare).not.toHaveBeenCalled();
  expect(historyMocks.open).not.toHaveBeenCalled();
  expect(realtimeMocks.createSession).not.toHaveBeenCalled();
  expect(result.current.state.error).toBe('请先从 Market 导入角色或场景');
});

it('requires a character conversation instead of creating a scene-only voice identity', async () => {
  sceneMocks.loadScenes.mockReturnValueOnce({
    selectedId: 'market-valley',
    scenes: [{ id: 'market-valley', name: '山谷', prompt: '山谷环境规则', kind: 'scene' }],
    hiddenBuiltinIds: [],
  });
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  const { result } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  expect(historyMocks.open).not.toHaveBeenCalled();
  expect(historyMocks.prepare).not.toHaveBeenCalled();
  expect(realtimeMocks.createSession).not.toHaveBeenCalled();
  expect(result.current.state.error).toContain('场景只提供环境');
});

it('keeps device evidence until the user starts a new spoken turn, not until a late transcript', async () => {
  const { createToolExecutionReceipt } = await import('@dg-agent/runtime');
  const settings = createDefaultSettings();
  settings.providers[settings.activeProviderId].apiKey = 'test';
  realtimeMocks.createSession.mockResolvedValue(realtimeSession(async () => undefined));
  const { result, unmount } = renderHook(() => useRealtimeCall(minimalDeviceSession(), settings));
  await act(async () => result.current.startCall());
  const options = realtimeMocks.createSession.mock.calls[0]![0] as RealtimeSessionOptions;
  const claim = '我把郊狼打开了。';
  expect(options.events.onAuthorizeAudio?.(claim)).toBe(false);
  bridgeMocks.onReceipt?.(
    createToolExecutionReceipt({
      runId: 'voice',
      callId: 'call-1',
      name: 'shock_start',
      args: {},
      output: JSON.stringify({ ok: true, command: { type: 'start' } }),
    }),
  );
  // The user's transcript for the same turn often lands after the tool ran.
  act(() => options.events.onTranscript?.({ id: 'u1', role: 'user', text: '打开', done: true }));
  expect(options.events.onAuthorizeAudio?.(claim)).toBe(true);
  options.events.onUserTurnStarted?.();
  expect(options.events.onAuthorizeAudio?.(claim)).toBe(false);
  unmount();
});
