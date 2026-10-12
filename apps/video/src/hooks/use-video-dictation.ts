import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createSpeechRecognitionController,
  getBrowserSpeechCapabilities,
  SPEECH_ABORTED_ERROR_MESSAGE,
  type SpeechRecognitionController,
} from '@dg-agent/audio-browser';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';

/** Dictation fills an editable draft; it never sends a message or calls a device. */
export function useVideoDictation(enabled: boolean) {
  const controller = useRef<SpeechRecognitionController | null>(null);
  const generation = useRef(0);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');

  const abort = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    setListening(false);
    setPartial('');
  }, []);

  useEffect(() => {
    if (!enabled) abort();
  }, [enabled, abort]);
  useEffect(
    () => () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const toggle = useCallback(
    async (onTranscript: (text: string) => void) => {
      if (controller.current) {
        controller.current.stop();
        return;
      }
      if (!enabled) return;
      const settings = new BrowserAppSettingsStore().load();
      if (!settings.speechRecognitionEnabled) {
        setError('请先在 AI 语音设置中开启语音识别');
        return;
      }
      if (!getBrowserSpeechCapabilities().recognitionSupported) {
        setError('当前环境不支持语音识别');
        return;
      }
      const current = ++generation.current;
      const speech = createSpeechRecognitionController({
        lang: settings.speechRecognitionLanguage,
      });
      controller.current = speech;
      setError('');
      setPartial('');
      setListening(true);
      try {
        const transcript = await speech.transcribeOnce({
          manualStop: true,
          onPartialTranscript: (text) => {
            if (generation.current === current) setPartial(text.slice(0, 5_000));
          },
        });
        if (generation.current !== current) return;
        if (transcript.trim()) onTranscript(transcript.trim());
        else setError('没有识别到语音，请重试');
      } catch (cause) {
        if (generation.current !== current) return;
        const message = cause instanceof Error ? cause.message : '语音识别失败';
        if (message !== SPEECH_ABORTED_ERROR_MESSAGE) setError(message);
      } finally {
        if (generation.current === current) {
          controller.current = null;
          setListening(false);
          setPartial('');
        }
      }
    },
    [enabled],
  );

  return { listening, partial, error, toggle, abort };
}
