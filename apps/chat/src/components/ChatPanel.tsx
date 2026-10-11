import { useVisibleMessageRead, type VisibleMessageRead } from '../hooks/use-visible-message-read';
import type { ChatReplyContext } from '../lib/protocol';
import {
  Overlay,
  ConversationInput,
  ConversationTimeline,
  ConversationComposer,
  ConversationEmpty,
  ConversationMessageRow,
  RecordedVoicePreview,
  conversationBubbleClass,
} from '@0xnullai/ui';
import { requestProfileView } from '@0xnullai/auth';
import { adaptHumanChatTimeline } from '@0xnullai/conversation';
import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Image as ImageIcon, Mic, X, AtSign, UserRound, Reply } from 'lucide-react';
import type { ChatMessage, ChatMention } from '../lib/protocol';
import { compressImage, startRecording, formatDuration, type Recorder } from '../lib/media';
import { PublicCharacterShareDialog } from './PublicCharacterShareDialog';
import { publicCharacterLink } from '../lib/public-character-share';
import { ProfileAvatar } from './ProfileAvatar';

interface ChatPanelProps {
  conversationId: string;
  messages: ChatMessage[];
  onMessageVisible?: VisibleMessageRead;
  hasOlderHistory?: boolean;
  historyLoading?: boolean;
  onLoadOlderHistory?: () => void;
  onSend: (
    text: string,
    mentions?: ChatMention[],
    replyTo?: ChatMessage['replyTo'],
  ) => boolean | void;
  /** Upload and send media (image/voice). The caller should ignore this while the room is not ready. */
  onSendMedia: (
    blob: Blob,
    kind: 'image' | 'audio',
    meta?: { durationMs?: number; w?: number; h?: number },
    reply?: ChatReplyContext,
  ) => Promise<void>;
  /**
   * Members that can be @-mentioned (other members + yourself), and the source
   * for a sender's avatar.
   *
   * `username` is how a bubble finds the account behind a sender. It is looked
   * up here rather than carried on the message because the room's chat frame is
   * reconstructed field by field in the Durable Object; adding to it would mean
   * a protocol and a storage change for something the member list already
   * knows. Absent for anonymous peers, for the room AI, and for history from
   * someone who has since left — all of which correctly render an inert avatar.
   */
  members?: { peerId: string; name: string; username?: string | null }[];
  /** Your own peerId (used to highlight messages that mention you). */
  selfId?: string;
  /** Current socket capability; only private DM media requires it for reads. */
  privateMediaToken?: string | null;
  /** Resend a message the server did not confirm, with its original id. */
  onRetryMessage?: (id: string) => boolean;
  /** Drop a failed local message. */
  onDiscardMessage?: (id: string) => void;
}

function mediaSource(url: string, privateMediaToken?: string | null): string | null {
  if (privateMediaToken === undefined) return url;
  return privateMediaToken ? `${url}?token=${encodeURIComponent(privateMediaToken)}` : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Highlight @role-name/@nickname inside the text. Your own bubble has an accent background, so
 *  there the @ switches to underline + bold to stay readable. */
function renderMessageText(
  text: string,
  mentions?: ChatMention[],
  isSelf = false,
): React.ReactNode {
  const publicLink = publicCharacterLink(text);
  if (publicLink)
    return (
      <a
        href={publicLink}
        target="_blank"
        rel="noopener noreferrer"
        className="block whitespace-pre-wrap underline underline-offset-2"
      >
        {text.split('\n')[0]} · 查看角色
      </a>
    );
  const names = (mentions ?? []).map((m) => m.displayName).filter(Boolean);
  if (names.length === 0) return text;
  const re = new RegExp(`(@(?:${names.map(escapeRegExp).join('|')}))`, 'g');
  const cls = isSelf
    ? 'font-semibold underline underline-offset-2'
    : 'font-medium text-[var(--accent)]';
  return text.split(re).map((part, i) =>
    part.startsWith('@') && names.includes(part.slice(1)) ? (
      <span key={i} className={cls}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function ChatPanel({
  conversationId,
  messages,
  onMessageVisible,
  onSend,
  onSendMedia,
  members = [],
  selfId,
  privateMediaToken,
  onRetryMessage,
  onDiscardMessage,
  hasOlderHistory,
  historyLoading,
  onLoadOlderHistory,
}: ChatPanelProps) {
  // Sender id to account handle. Rebuilt per render from a list that is at most
  // a roomful long, which is cheaper than the memo that would guard it.
  const usernameByPeer = new Map(members.map((m) => [m.peerId, m.username ?? null]));
  const [sharingCharacter, setSharingCharacter] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage['replyTo']>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [pendingMedia, setPendingMedia] = useState<{
    blob: Blob;
    kind: 'image' | 'audio';
    meta: { durationMs?: number; w?: number; h?: number };
    reply?: ChatReplyContext;
    attempted?: boolean;
  } | null>(null);
  const pendingMentionsRef = useRef<ChatMention[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageElements = useRef(new Map<string, HTMLDivElement>());
  const timeline = adaptHumanChatTimeline({
    conversationId,
    messages,
    mediaAccess: privateMediaToken === undefined ? 'room_authorized_url' : 'socket_capability',
    mediaConnected: privateMediaToken !== null,
  });
  const latestConfirmed = [...timeline].reverse().find((item) => item.status === 'saved')?.itemId;
  const readError = useVisibleMessageRead(latestConfirmed, messageElements, onMessageVisible);
  const fileRef = useRef<HTMLInputElement>(null);
  const recStartRef = useRef(0);
  const recorderRef = useRef<Recorder | null>(null);
  const recordingGenerationRef = useRef(0);

  const mentionCandidates =
    mentionQuery !== null
      ? members
          .filter((m) => m.name && m.name.toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 6)
      : [];

  function handleInputChange(value: string) {
    setDraft(value);
    const m = /@([^\s@]*)$/.exec(value);
    setMentionQuery(m?.[1] ?? null);
  }

  function selectMention(member: { peerId: string; name: string }) {
    setDraft((prev) => prev.replace(/@([^\s@]*)$/, `@${member.name} `));
    if (!pendingMentionsRef.current.some((x) => x.peerId === member.peerId)) {
      pendingMentionsRef.current.push({ peerId: member.peerId, displayName: member.name });
    }
    setMentionQuery(null);
  }

  const latestMessageId = timeline.at(-1)?.itemId;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latestMessageId]);

  // Recording timer: the start time lives in a ref, the interval computes elapsed duration from it.
  useEffect(() => {
    if (!recorder) return;
    const t = window.setInterval(() => setRecElapsed(Date.now() - recStartRef.current), 250);
    return () => clearInterval(t);
  }, [recorder]);

  useEffect(
    () => () => {
      recordingGenerationRef.current += 1;
      recorderRef.current?.cancel();
      recorderRef.current = null;
    },
    [],
  );

  function replyMentions(): ChatMention[] {
    return replyTo &&
      replyTo.senderId !== selfId &&
      members.some((m) => m.peerId === replyTo.senderId)
      ? [{ peerId: replyTo.senderId, displayName: replyTo.senderName }]
      : [];
  }
  function mediaReply(): ChatReplyContext | undefined {
    return replyTo ? { replyTo, mentions: replyMentions() } : undefined;
  }
  function handleSend() {
    const text = draft.trim();
    if (!text || busy || recorder || pendingMedia) return;
    // Keep only the @ mentions that still appear in the text.
    const mentions = pendingMentionsRef.current.filter((m) => text.includes(`@${m.displayName}`));
    mentions.push(
      ...replyMentions().filter((reply) => !mentions.some((m) => m.peerId === reply.peerId)),
    );
    const accepted = onSend(text, mentions.length ? mentions : undefined, replyTo);
    if (accepted === false) {
      setMediaError('消息尚未发送，连接恢复后请重试');
      return;
    }
    setDraft('');
    setReplyTo(undefined);
    pendingMentionsRef.current = [];
    setMentionQuery(null);
  }

  async function handlePickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy || recorder || pendingMedia) return;
    const generation = ++recordingGenerationRef.current;
    const reply = mediaReply();
    setBusy(true);
    setMediaError(null);
    try {
      const { blob, w, h } = await compressImage(file);
      if (generation !== recordingGenerationRef.current) return;
      try {
        await onSendMedia(blob, 'image', { w, h }, reply);
      } catch (err) {
        if (generation === recordingGenerationRef.current)
          setPendingMedia({ blob, kind: 'image', meta: { w, h }, reply });
        throw err;
      }
      if (generation === recordingGenerationRef.current) setReplyTo(undefined);
    } catch (err) {
      console.error('[Chat] image send failed', err);
      if (generation === recordingGenerationRef.current) setMediaError('图片发送失败，请重试');
    } finally {
      if (generation === recordingGenerationRef.current) setBusy(false);
    }
  }

  async function startRec() {
    if (busy || recorderRef.current || pendingMedia) return;
    const generation = ++recordingGenerationRef.current;
    setBusy(true);
    setMediaError(null);
    try {
      const rec = await startRecording();
      if (generation !== recordingGenerationRef.current) {
        rec.cancel();
        return;
      }
      recStartRef.current = Date.now();
      setRecElapsed(0);
      recorderRef.current = rec;
      setRecorder(rec);
    } catch (err) {
      console.error('[Chat] mic access failed', err);
      setMediaError('无法访问麦克风，请检查权限设置');
    } finally {
      if (generation === recordingGenerationRef.current) setBusy(false);
    }
  }

  async function stopRecAndPreview() {
    if (!recorder) return;
    const rec = recorder;
    const reply = mediaReply();
    const generation = ++recordingGenerationRef.current;
    recorderRef.current = null;
    setRecorder(null);
    setBusy(true);
    try {
      const { blob, durationMs } = await rec.stop();
      if (generation !== recordingGenerationRef.current) return;
      if (blob.size > 0) setPendingMedia({ blob, kind: 'audio', meta: { durationMs }, reply });
    } catch (err) {
      console.error('[Chat] voice recording failed', err);
      if (generation === recordingGenerationRef.current) setMediaError('语音录制失败，请重试');
    } finally {
      if (generation === recordingGenerationRef.current) setBusy(false);
    }
  }

  function cancelRec() {
    recordingGenerationRef.current += 1;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setRecorder(null);
  }

  async function retryMedia() {
    if (!pendingMedia || busy) return;
    const media = pendingMedia;
    const generation = ++recordingGenerationRef.current;
    setBusy(true);
    setMediaError(null);
    try {
      await onSendMedia(media.blob, media.kind, media.meta, media.reply);
      if (generation === recordingGenerationRef.current) {
        setPendingMedia(null);
        setReplyTo(undefined);
      }
    } catch (err) {
      console.error('[Chat] media retry failed', err);
      if (generation === recordingGenerationRef.current) {
        setPendingMedia((current) =>
          current === media ? { ...current, attempted: true } : current,
        );
        setMediaError(media.kind === 'image' ? '图片发送失败，请重试' : '语音发送失败，请重试');
      }
    } finally {
      if (generation === recordingGenerationRef.current) setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Message list */}
      <ConversationTimeline>
        {hasOlderHistory && (
          <button
            type="button"
            disabled={historyLoading}
            onClick={onLoadOlderHistory}
            className="mb-3 w-full rounded border border-[var(--surface-border)] p-2 text-sm"
          >
            {historyLoading ? '读取中…' : '加载更早的消息'}
          </button>
        )}
        {readError && (
          <p role="status" className="px-3 text-xs text-[var(--text-faint)]">
            {readError}
          </p>
        )}
        {messages.length === 0 && <ConversationEmpty />}

        {messages.map((msg, idx) => {
          const item = timeline[idx]!;
          const isSelf = msg.fromSelf;
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const sameSender = prevMsg?.senderId === msg.senderId;
          const closeInTime = prevMsg && msg.timestamp - prevMsg.timestamp < 60000;
          const grouped = sameSender && closeInTime;
          const hasMedia = !!msg.media;

          return (
            <ConversationMessageRow
              key={msg.id}
              data-message-id={msg.id}
              tabIndex={-1}
              own={isSelf}
              grouped={!!grouped}
              avatar={
                <ProfileAvatar
                  name={msg.senderName || msg.senderId.slice(0, 6)}
                  username={usernameByPeer.get(msg.senderId)}
                  size={28}
                />
              }
              ref={(element) => {
                if (element) messageElements.current.set(msg.id, element);
                else messageElements.current.delete(msg.id);
              }}
            >
              {msg.replyTo && (
                <blockquote className="mb-1 rounded border-l-2 border-[var(--accent)] bg-[var(--bg-soft)] px-2 py-1 text-xs text-[var(--text-soft)]">
                  {msg.replyTo.unavailable ? (
                    '原消息已不可用'
                  ) : (
                    <>
                      <button
                        type="button"
                        className="block w-full text-left"
                        disabled={!messages.some((source) => source.id === msg.replyTo?.id)}
                        title={
                          messages.some((source) => source.id === msg.replyTo?.id)
                            ? '定位原消息'
                            : '加载更早消息后可定位'
                        }
                        aria-label={`定位 ${msg.replyTo.senderName} 的原消息`}
                        onClick={() => {
                          const source = messageElements.current.get(msg.replyTo!.id);
                          source?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          source?.focus({ preventScroll: true });
                        }}
                      >
                        <strong>{msg.replyTo.senderName}</strong>
                        <span className="block line-clamp-3 whitespace-pre-wrap">
                          {msg.replyTo.text}
                        </span>
                      </button>
                    </>
                  )}
                </blockquote>
              )}
              {!isSelf && !grouped && (
                <div className="mb-0.5 flex min-w-0 items-center gap-1 px-1 text-xs text-[var(--text-faint)]">
                  {usernameByPeer.get(msg.senderId) ? (
                    <button
                      type="button"
                      className="truncate hover:text-[var(--accent)] hover:underline"
                      onClick={() => requestProfileView(usernameByPeer.get(msg.senderId)!)}
                    >
                      {msg.senderName || msg.senderId.slice(0, 6)}
                    </button>
                  ) : (
                    <span className="truncate">{msg.senderName || msg.senderId.slice(0, 6)}</span>
                  )}
                </div>
              )}

              {msg.media?.kind === 'image' && mediaSource(msg.media.url, privateMediaToken) ? (
                <button
                  onClick={() => setLightbox(mediaSource(msg.media!.url, privateMediaToken))}
                  className="block overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)]"
                >
                  <img
                    src={mediaSource(msg.media.url, privateMediaToken)!}
                    alt="图片"
                    loading="lazy"
                    className="max-h-60 max-w-full object-cover"
                  />
                </button>
              ) : msg.media?.kind === 'audio' && mediaSource(msg.media.url, privateMediaToken) ? (
                <div
                  className={
                    isSelf
                      ? 'rounded-[var(--radius-md)] rounded-br-[var(--radius-2xs)] bg-[var(--accent)] px-3 py-2'
                      : 'rounded-[var(--radius-md)] rounded-bl-[var(--radius-2xs)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2'
                  }
                >
                  <audio
                    controls
                    src={mediaSource(msg.media.url, privateMediaToken)!}
                    className="max-w-[220px]"
                  />
                  {msg.media.durationMs != null && (
                    <p
                      className={`mt-0.5 text-[10px] ${isSelf ? 'text-[var(--button-text)]' : 'text-[var(--text-faint)]'}`}
                    >
                      语音 {formatDuration(msg.media.durationMs)}
                    </p>
                  )}
                </div>
              ) : msg.media && privateMediaToken === null ? (
                <span className="text-xs text-[var(--text-faint)]">连接后加载媒体</span>
              ) : null}

              {msg.senderId !== 'system' && (
                <button
                  type="button"
                  aria-label={`回复 ${msg.senderName || '消息'}`}
                  title="回复此消息"
                  disabled={busy || !!recorder || !!pendingMedia}
                  className="float-right ml-1 flex h-7 w-7 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-soft)]"
                  onClick={() => {
                    setReplyTo({
                      id: msg.id,
                      senderId: msg.senderId,
                      senderName: msg.senderName,
                      text:
                        msg.text.slice(0, 500) ||
                        (msg.media?.kind === 'image' ? '[图片]' : '[语音]'),
                    });
                    inputRef.current?.focus();
                  }}
                >
                  <Reply size={14} />
                </button>
              )}
              {(!hasMedia || msg.text) && (
                <div
                  className={
                    `${hasMedia ? 'mt-1 ' : ''}` +
                    conversationBubbleClass(
                      isSelf,
                      Boolean(selfId && msg.mentions?.some((m) => m.peerId === selfId)),
                    ) +
                    ' whitespace-pre-wrap'
                  }
                >
                  {renderMessageText(msg.text, msg.mentions, isSelf)}
                </div>
              )}

              {!grouped && (
                <p
                  className={`mt-0.5 px-1 text-[10px] text-[var(--text-faint)] ${
                    isSelf ? 'text-right' : 'text-left'
                  }`}
                >
                  {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {item.status === 'pending' && msg.fromSelf && ' · 发送中…'}
                </p>
              )}
              {item.status === 'failed' && msg.fromSelf && (
                <p
                  role="alert"
                  className="mt-0.5 px-1 text-right text-[10px] text-[var(--danger,#dc2626)]"
                >
                  发送失败
                  {onRetryMessage && (
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => onRetryMessage(msg.id)}
                    >
                      重试
                    </button>
                  )}
                  {onDiscardMessage && (
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => onDiscardMessage(msg.id)}
                    >
                      放弃
                    </button>
                  )}
                </p>
              )}
            </ConversationMessageRow>
          );
        })}
        <div ref={bottomRef} />
      </ConversationTimeline>

      {/* Input bar */}
      <ConversationComposer>
        {sharingCharacter && (
          <PublicCharacterShareDialog onSend={onSend} onClose={() => setSharingCharacter(false)} />
        )}
        {replyTo && (
          <div
            className="mb-2 flex items-start justify-between gap-2 rounded border-l-2 border-[var(--accent)] bg-[var(--bg-soft)] p-2 text-xs"
            role="status"
          >
            <div className="min-w-0">
              <strong>回复 {replyTo.senderName}</strong>
              {replyTo.senderId.startsWith('ai:') &&
                members.some((m) => m.peerId === replyTo.senderId) && <span> · 将提醒该 AI</span>}
              <p className="line-clamp-2 whitespace-pre-wrap">{replyTo.text}</p>
            </div>
            <button
              type="button"
              aria-label="取消回复"
              disabled={busy || !!recorder || !!pendingMedia}
              onClick={() => setReplyTo(undefined)}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {/* @ mention candidates */}
        {mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 max-h-44 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow)]">
            {mentionCandidates.map((m) => (
              <button
                key={m.peerId}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectMention(m);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--bg-soft)]"
              >
                <AtSign size={13} className="shrink-0 text-[var(--text-faint)]" />
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
        )}
        {mediaError && (
          <div
            role="alert"
            className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-1.5 text-sm text-[var(--danger)]"
          >
            <span>{mediaError}</span>
            <button
              type="button"
              onClick={() => setMediaError(null)}
              aria-label="关闭发送错误"
              className="shrink-0 text-[var(--text-faint)] hover:text-[var(--text)]"
              title="关闭"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {pendingMedia && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" role="status">
            <span>{pendingMedia.kind === 'image' ? '图片待发送' : '录音待发送'}</span>
            {pendingMedia.kind === 'audio' && <RecordedVoicePreview blob={pendingMedia.blob} />}
            <button type="button" disabled={busy} onClick={retryMedia}>
              {pendingMedia.attempted || pendingMedia.kind === 'image'
                ? '重试发送附件'
                : '确认发送语音'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPendingMedia(null);
                setMediaError(null);
              }}
            >
              丢弃附件
            </button>
          </div>
        )}
        {recorder ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={cancelRec}
              aria-label="取消录音"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--danger)] transition-colors"
              title="取消录音"
            >
              <X size={20} />
            </button>
            <div className="flex flex-1 items-center gap-2 text-sm text-[var(--danger)]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--danger)]" />
              录音中 {formatDuration(recElapsed)}
            </div>
            <button
              type="button"
              onClick={stopRecAndPreview}
              aria-label="结束录音"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90"
              title="结束录音"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="order-3 flex w-full items-center gap-1 sm:order-none sm:w-auto">
              <button
                type="button"
                onClick={() => setSharingCharacter(true)}
                aria-label="分享公开角色"
                disabled={!!replyTo}
                className="flex min-h-[44px] min-w-[36px] items-center justify-center text-[var(--text-soft)]"
              >
                <UserRound size={20} />
              </button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={handlePickImage} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="发送图片"
                disabled={busy || !!pendingMedia}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
                title="发送图片"
              >
                <ImageIcon size={20} />
              </button>
              <button
                type="button"
                onClick={startRec}
                aria-label="发送语音"
                disabled={busy || !!pendingMedia}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
                title="发送语音"
              >
                <Mic size={20} />
              </button>
            </div>
            <ConversationInput
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMentionQuery(null);
                else if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                )
                  handleSend();
              }}
              placeholder={busy ? '发送中…' : '输入消息…'}
              disabled={busy}
            />
            <button
              type="button"
              onClick={handleSend}
              aria-label="发送消息"
              disabled={!draft.trim() || busy || !!pendingMedia}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        )}
      </ConversationComposer>

      {/* Image lightbox */}
      {lightbox && (
        <Overlay onDismiss={() => setLightbox(null)} scrim="strong">
          <img
            src={lightbox}
            alt="图片"
            className="max-h-full max-w-full rounded-[var(--radius-sm)]"
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="关闭图片预览"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white"
          >
            <X size={22} />
          </button>
        </Overlay>
      )}
    </div>
  );
}
