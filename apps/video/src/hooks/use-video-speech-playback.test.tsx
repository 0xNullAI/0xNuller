// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useVideoSpeechPlayback } from './use-video-speech-playback';

const speech = vi.hoisted(() => ({
  settings: {
    speechSynthesisEnabled: true,
    speechSynthesisLanguage: 'zh-CN',
    voice: { mode: 'browser', proxyUrl: '', apiKey: '', speaker: '', browserVoiceUri: '' },
  },
  speak: vi.fn(),
  stop: vi.fn(),
  supported: true,
  account: 'alice',
  offer: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  audio: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
}));
vi.mock('@0xnullai/auth', () => ({
  currentAuthUserId: () => speech.account,
  subscribeAuthChanges: () => () => undefined,
}));
vi.mock('../services/managed-tts-client.js', () => ({
  managedTtsOffer: speech.offer,
  managedTtsMaxCredits: (text: string, offer: { rate: number }) =>
    Array.from(text).length * 2 * offer.rate,
  createManagedTts: speech.create,
  loadManagedTtsJob: speech.load,
  loadManagedTtsAudio: speech.audio,
}));
vi.mock('@dg-agent/storage-browser', () => ({
  BrowserAppSettingsStore: class {
    load() {
      return speech.settings;
    }
  },
}));
vi.mock('@dg-agent/audio-browser', () => ({
  createSpeechSynthesizer: () => ({ speak: speech.speak, stop: speech.stop }),
  getBrowserSpeechCapabilities: () => ({ synthesisSupported: speech.supported }),
  SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE: '语音合成播放已停止',
}));

beforeEach(() => {
  vi.clearAllMocks();
  speech.settings.speechSynthesisEnabled = true;
  speech.supported = true;
  speech.account = 'alice';
  speech.audio.mockResolvedValue(new Blob(['ID3'], { type: 'audio/mpeg' }));
  speech.play.mockResolvedValue(undefined);
  vi.stubGlobal(
    'Audio',
    class {
      play = speech.play;
      pause = speech.pause;
      onended = null;
      onerror = null;
    },
  );
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});

it('requires an explicit Credit confirmation and never auto-plays generated managed audio', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  speech.offer.mockResolvedValue({ rate: 2, priceVersion: 'v1', maxTextCharacters: 500 });
  speech.create.mockResolvedValue({
    id: 'test-id',
    state: 'succeeded',
    credits: 6,
    audioAvailable: true,
  });
  const { result } = renderHook(() => useVideoSpeechPlayback(true, true));
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('8 Credit'));
  expect(speech.create).toHaveBeenCalledOnce();
  expect(speech.audio).toHaveBeenCalledOnce();
  expect(speech.play).not.toHaveBeenCalled();
  expect(result.current.notice).toContain('再次点击播放');
  expect(result.current.activeMessageId).toBeNull();
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(speech.play).toHaveBeenCalledOnce();
  expect(speech.create).toHaveBeenCalledOnce();
  confirm.mockRestore();
});

it('coalesces simultaneous managed clicks while a paid request is pending', async () => {
  let resolve!: (value: {
    id: string;
    state: string;
    credits: number;
    audioAvailable: boolean;
  }) => void;
  speech.offer.mockResolvedValue({ rate: 2, priceVersion: 'v1', maxTextCharacters: 500 });
  speech.create.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { result } = renderHook(() => useVideoSpeechPlayback(true, true));
  act(() => {
    void result.current.toggle('reply-1', '你好');
  });
  await vi.waitFor(() => expect(speech.create).toHaveBeenCalledOnce());
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(speech.create).toHaveBeenCalledOnce();
  await act(async () => {
    resolve({ id: 'test-id', state: 'succeeded', credits: 8, audioAvailable: true });
    await Promise.resolve();
  });
  confirm.mockRestore();
});

it('does not reuse paid audio when an observation id is recycled with different text', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  speech.offer.mockResolvedValue({ rate: 2, priceVersion: 'v1', maxTextCharacters: 500 });
  speech.create.mockImplementation(async (_account: string, id: string) => ({
    id,
    state: 'succeeded',
    credits: 8,
    audioAvailable: true,
  }));
  const { result } = renderHook(() => useVideoSpeechPlayback(true, true));
  await act(async () => {
    await result.current.toggle('observation-1', '你好');
  });
  await act(async () => {
    await result.current.toggle('observation-1', '晚安');
  });
  expect(speech.create).toHaveBeenCalledTimes(2);
  expect(speech.play).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it('does not contact the provider when managed Credit consent is declined', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  speech.offer.mockResolvedValue({ rate: 2, priceVersion: 'v1', maxTextCharacters: 500 });
  const { result } = renderHook(() => useVideoSpeechPlayback(true, true));
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(speech.create).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it('reads only the selected reply and stops on a second click', async () => {
  speech.speak.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const { result } = renderHook(() => useVideoSpeechPlayback(true));
  act(() => {
    void result.current.toggle('reply-1', '你好');
  });
  expect(speech.speak).toHaveBeenCalledWith('你好');
  expect(result.current.activeMessageId).toBe('reply-1');
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(speech.stop).toHaveBeenCalledOnce();
  expect(result.current.activeMessageId).toBeNull();
});

it('drops late playback completion after access ends', async () => {
  let finish!: () => void;
  speech.speak.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ enabled }) => useVideoSpeechPlayback(enabled), {
    initialProps: { enabled: true },
  });
  act(() => {
    void result.current.toggle('reply-1', '旧账号的话');
  });
  rerender({ enabled: false });
  expect(speech.stop).toHaveBeenCalled();
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  expect(result.current.activeMessageId).toBeNull();
});

it('honors the existing synthesis setting', async () => {
  speech.settings.speechSynthesisEnabled = false;
  const { result } = renderHook(() => useVideoSpeechPlayback(true));
  await act(async () => {
    await result.current.toggle('reply-1', '你好');
  });
  expect(result.current.error).toContain('开启语音合成');
  expect(speech.speak).not.toHaveBeenCalled();
});
