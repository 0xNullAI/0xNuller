// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useVideoDictation } from './use-video-dictation';

const speech = vi.hoisted(() => ({
  settings: {
    speechRecognitionEnabled: true,
    speechRecognitionLanguage: 'zh-CN',
    voice: { mode: 'browser', proxyUrl: '', apiKey: '', autoStopEnabled: false },
  },
  transcribeOnce: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  supported: true,
}));
vi.mock('@dg-agent/storage-browser', () => ({
  BrowserAppSettingsStore: class {
    load() {
      return speech.settings;
    }
  },
}));
vi.mock('@dg-agent/audio-browser', () => ({
  createSpeechRecognitionController: () => ({
    transcribeOnce: speech.transcribeOnce,
    stop: speech.stop,
    abort: speech.abort,
  }),
  getBrowserSpeechCapabilities: () => ({ recognitionSupported: speech.supported }),
  SPEECH_ABORTED_ERROR_MESSAGE: '语音采集已停止',
}));

beforeEach(() => {
  vi.clearAllMocks();
  speech.settings.speechRecognitionEnabled = true;
  speech.supported = true;
});

it('keeps recognized words as a draft until the user sends them', async () => {
  let finish!: (text: string) => void;
  speech.transcribeOnce.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useVideoDictation(true));
  act(() => {
    void result.current.toggle(onTranscript);
  });
  expect(result.current.listening).toBe(true);
  expect(onTranscript).not.toHaveBeenCalled();
  act(() => {
    void result.current.toggle(onTranscript);
  });
  expect(speech.stop).toHaveBeenCalledOnce();
  await act(async () => {
    finish('  今天想聊天  ');
    await Promise.resolve();
  });
  expect(onTranscript).toHaveBeenCalledWith('今天想聊天');
  expect(result.current.listening).toBe(false);
});

it('drops late recognition after camera or conversation access ends', async () => {
  let finish!: (text: string) => void;
  speech.transcribeOnce.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const onTranscript = vi.fn();
  const { result, rerender } = renderHook(({ enabled }) => useVideoDictation(enabled), {
    initialProps: { enabled: true },
  });
  act(() => {
    void result.current.toggle(onTranscript);
  });
  rerender({ enabled: false });
  expect(speech.abort).toHaveBeenCalled();
  await act(async () => {
    finish('旧账号的话');
    await Promise.resolve();
  });
  expect(onTranscript).not.toHaveBeenCalled();
});

it('honors the existing voice-recognition setting', async () => {
  speech.settings.speechRecognitionEnabled = false;
  const { result } = renderHook(() => useVideoDictation(true));
  await act(async () => {
    await result.current.toggle(vi.fn());
  });
  expect(result.current.error).toContain('开启语音识别');
  expect(speech.transcribeOnce).not.toHaveBeenCalled();
});
