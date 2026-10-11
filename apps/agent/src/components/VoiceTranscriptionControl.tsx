import { useEffect, useRef, useState } from 'react';
import { PrivateConversationAttachmentChannel, type VoiceTranscription } from '@0xnullai/auth';

interface Props {
  accountId: string;
  conversationId: string;
  attachmentId: string;
  onUseText: (text: string) => void;
}

/** The model output is a draft: only the user can put it into the normal composer. */
export function VoiceTranscriptionControl({
  accountId,
  conversationId,
  attachmentId,
  onUseText,
}: Props) {
  const channelRef = useRef<PrivateConversationAttachmentChannel | null>(null);
  const [details, setDetails] = useState<VoiceTranscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      channelRef.current?.dispose();
      channelRef.current = null;
    },
    [accountId, conversationId],
  );

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    const channel = new PrivateConversationAttachmentChannel(accountId, conversationId);
    channelRef.current?.dispose();
    channelRef.current = channel;
    try {
      setDetails(await channel.transcription(attachmentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '识别状态暂不可用');
    } finally {
      if (channelRef.current === channel) setLoading(false);
    }
  }

  async function start(): Promise<void> {
    if (!details?.offer || !channelRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const job = await channelRef.current.transcribe(attachmentId, details.offer);
      setDetails({ ...details, job });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '识别失败');
      // The server may still be settling. A fresh GET is authoritative.
      try {
        setDetails(await channelRef.current.transcription(attachmentId));
      } catch {
        /* retain error */
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 text-xs">
      {!details && (
        <button
          type="button"
          className="underline disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? '读取识别报价…' : '转写这段语音'}
        </button>
      )}
      {details && !details.job && details.offer && (
        <div className="space-y-1">
          <p>
            语音识别：最高 {details.offer.maxCredits} Credit；按识别出的实际秒数，每秒{' '}
            {details.offer.rate} Credit 结算。录音会发送给语音服务商。
          </p>
          <button
            type="button"
            className="underline disabled:opacity-50"
            disabled={loading}
            onClick={() => void start()}
          >
            {loading ? '识别中…' : '同意价格并开始识别'}
          </button>
        </div>
      )}
      {details && !details.enabled && !details.job && <p>语音识别尚未启用。</p>}
      {details?.job?.state === 'succeeded' && details.job.transcript && (
        <div className="space-y-1">
          <p>机器转写草稿 · 已扣 {details.job.credits} Credit。请核对录音内容。</p>
          <p>{details.job.transcript}</p>
          <button
            type="button"
            className="underline"
            onClick={() => onUseText(details.job!.transcript!)}
          >
            填入输入框核对
          </button>
        </div>
      )}
      {details?.job && details.job.state !== 'succeeded' && (
        <div>
          <p>
            {details.job.state === 'needs_review'
              ? '识别或账务待核对，暂未提供文字'
              : details.job.state === 'failed'
                ? '识别失败，未扣 Credit'
                : '识别或结算处理中'}
          </p>
          <button
            type="button"
            className="underline disabled:opacity-50"
            disabled={loading}
            onClick={() => void load()}
          >
            刷新状态
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
