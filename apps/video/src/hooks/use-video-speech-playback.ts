import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createSpeechSynthesizer,
  getBrowserSpeechCapabilities,
  SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE,
  type SpeechSynthesizer,
} from '@dg-agent/audio-browser';
import { BrowserAppSettingsStore } from '@dg-agent/storage-browser';
import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import {
  createManagedTts,
  loadManagedTtsAudio,
  loadManagedTtsJob,
  managedTtsMaxCredits,
  managedTtsOffer,
} from '../services/managed-tts-client.js';

/** Playback is explicit and local; the saved conversation remains text. */
export function useVideoSpeechPlayback(enabled: boolean, managed = false) {
  const synthesizer = useRef<SpeechSynthesizer | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const preparedMessageId = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const paidJobs = useRef(new Map<string, string>());
  const generation = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const stop = useCallback(() => {
    generation.current += 1;
    synthesizer.current?.stop();
    synthesizer.current = null;
    pending.current?.abort();
    pending.current = null;
    audio.current?.pause();
    audio.current = null;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
    preparedMessageId.current = null;
    setActiveMessageId(null);
  }, []);

  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  useEffect(
    () => () => {
      stop();
    },
    [stop],
  );
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        paidJobs.current.clear();
        stop();
        setNotice('');
      }),
    [stop],
  );

  const toggle = useCallback(
    async (messageId: string, text: string) => {
      if (managed) {
        if (!enabled || !text.trim()) return;
        if (pending.current) return;
        const messageKey = `${messageId}\0${text}`;
        if (audio.current) {
          const wasActive = activeMessageId === messageId;
          stop();
          if (wasActive) return;
        }
        if (preparedMessageId.current && preparedMessageId.current !== messageKey) stop();
        if (preparedMessageId.current === messageKey && audioUrl.current) {
          const current = ++generation.current;
          const player = new Audio(audioUrl.current);
          audio.current = player;
          player.onended = () => {
            if (generation.current === current) stop();
          };
          player.onerror = () => {
            if (generation.current === current) {
              stop();
              setError('音频播放失败');
            }
          };
          setNotice('');
          setActiveMessageId(messageId);
          try {
            await player.play();
          } catch {
            if (generation.current === current) {
              stop();
              setError('播放被浏览器阻止，请再次点击朗读');
            }
          }
          return;
        }
        const account = currentAuthUserId();
        if (!account) {
          setError('请先登录后使用托管朗读');
          return;
        }
        const current = ++generation.current;
        const controller = new AbortController();
        pending.current = controller;
        setError('');
        setNotice('');
        try {
          let id = paidJobs.current.get(messageKey);
          if (!id) {
            const offer = await managedTtsOffer(account, controller.signal);
            const max = managedTtsMaxCredits(text, offer);
            if (generation.current !== current) return;
            if (!window.confirm(`托管朗读最多预留 ${max} Credit，最终按实际字符扣费。继续生成？`))
              return;
            id = crypto.randomUUID().replaceAll('-', '');
            paidJobs.current.set(messageKey, id);
            const job = await createManagedTts(account, id, text, offer, controller.signal);
            if (job.state !== 'succeeded' || !job.audioAvailable)
              throw new Error('朗读已提交，请稍后再点此处查看结果');
            if (generation.current !== current) return;
            const blob = await loadManagedTtsAudio(account, id, controller.signal);
            if (generation.current !== current) return;
            audioUrl.current = URL.createObjectURL(blob);
            preparedMessageId.current = messageKey;
            setNotice(`朗读已生成，实扣 ${job.credits} Credit。再次点击播放。`);
            return;
          }
          const job = await loadManagedTtsJob(account, id, controller.signal);
          if (job.state === 'failed') {
            paidJobs.current.delete(messageKey);
            throw new Error('上次朗读失败，未扣费；可再次点击生成');
          }
          if (job.state !== 'succeeded' || !job.audioAvailable)
            throw new Error('朗读结果待核对或尚未完成，请稍后查看 Credit 记录');
          const blob = await loadManagedTtsAudio(account, id, controller.signal);
          if (generation.current !== current) return;
          audioUrl.current = URL.createObjectURL(blob);
          preparedMessageId.current = messageKey;
          setNotice('音频已准备好，再次点击播放。');
        } catch (cause) {
          if (generation.current === current && !controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : '托管朗读失败');
        } finally {
          if (pending.current === controller) pending.current = null;
        }
        return;
      }
      if (synthesizer.current) {
        const wasActive = activeMessageId === messageId;
        stop();
        if (wasActive) return;
      }
      if (!enabled || !text.trim()) return;
      const settings = new BrowserAppSettingsStore().load();
      if (!settings.speechSynthesisEnabled) {
        setError('请先在 AI 语音设置中开启语音合成');
        return;
      }
      if (!getBrowserSpeechCapabilities().synthesisSupported) {
        setError('当前环境不支持语音合成');
        return;
      }
      const current = ++generation.current;
      const speech = createSpeechSynthesizer({
        lang: settings.speechSynthesisLanguage,
        browserVoiceUri: settings.voice.browserVoiceUri,
      });
      synthesizer.current = speech;
      setError('');
      setActiveMessageId(messageId);
      try {
        await speech.speak(text);
      } catch (cause) {
        if (generation.current !== current) return;
        const message = cause instanceof Error ? cause.message : '语音播放失败';
        if (message !== SPEECH_SYNTHESIS_ABORTED_ERROR_MESSAGE) setError(message);
      } finally {
        if (generation.current === current) {
          synthesizer.current = null;
          setActiveMessageId(null);
        }
      }
    },
    [activeMessageId, enabled, managed, stop],
  );

  return { activeMessageId, error, notice, toggle, stop };
}
