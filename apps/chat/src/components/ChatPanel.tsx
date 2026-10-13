import { useVisibleMessageRead, type VisibleMessageRead } from '../hooks/use-visible-message-read';
import type { ChatReplyContext } from '../lib/protocol';
import {
  Overlay,
  ConversationInput,
  ConversationTimeline,
  ConversationComposer,
  ConversationEmpty,
  RecordedVoicePreview,
  conversationComposerButtonClass,
  conversationSequence,
  useConversationArrivals,
} from '@0xnullai/ui';
import { adaptHumanChatTimeline } from '@0xnullai/conversation';
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { ArrowUp, Image as ImageIcon, Mic, Plus, X, AtSign, UserRound } from 'lucide-react';
import { RECALL_WINDOW_MS } from '../../worker/wire';
import type { ChatMessage, ChatMention } from '../lib/protocol';
import { compressImage, startRecording, formatDuration, type Recorder } from '../lib/media';
import { PublicCharacterShareDialog } from './PublicCharacterShareDialog';
import { ChatMessageItem, type ChatMessageActions } from './ChatMessageItem';
import {
  MediaPermissionDeniedError,
  canOpenAppSettings,
  explainMediaFailure,
  openAppSettings,
} from '@0xnullai/native';

/** Bubbles laid out at a time; older ones appear in batches as the reader scrolls up. */
const RENDER_BATCH = 50;

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
  members?: { peerId: string; name: string; username?: string | null; hint?: string }[];
  /** Your own peerId (used to highlight messages that mention you). */
  selfId?: string;
  /** Current socket capability; only private DM media requires it for reads. */
  privateMediaToken?: string | null;
  /** Resend a message the server did not confirm, with its original id. */
  onRetryMessage?: (id: string) => boolean;
  /** Drop a failed local message. */
  onDiscardMessage?: (id: string) => void;
  /** Withdraw one of this account's confirmed messages within RECALL_WINDOW_MS. */
  onRecallMessage?: (id: string) => void;
  /** Scroll to this message, reading older pages until it is loaded. */
  jumpToMessageId?: string | null;
  /** The jump finished: `found` is false when history ran out first. */
  onJumpSettled?: (found: boolean) => void;
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
  onRecallMessage,
  hasOlderHistory,
  historyLoading,
  onLoadOlderHistory,
  jumpToMessageId,
  onJumpSettled,
}: ChatPanelProps) {
  // Re-evaluated every 15 s so the 撤回 button disappears once the window closes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // Sender id to account handle. Rebuilt per render from a list that is at most
  // a roomful long, which is cheaper than the memo that would guard it.
  const usernameByPeer = new Map(members.map((m) => [m.peerId, m.username ?? null]));
  // Whose AI a group AI is, shown next to its name so nobody mistakes it for a person.
  const hintByPeer = new Map(members.flatMap((m) => (m.hint ? [[m.peerId, m.hint]] : [])));
  const [sharingCharacter, setSharingCharacter] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage['replyTo']>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mediaError, setMediaErrorState] = useState<string | null>(null);
  /** The error is a refused microphone the user can only allow in the App's system settings. */
  const [mediaErrorOpensSettings, setMediaErrorOpensSettings] = useState(false);
  const setMediaError = (message: string | null, opensSettings = false) => {
    setMediaErrorState(message);
    setMediaErrorOpensSettings(opensSettings);
  };
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
  // Render the newest messages first and reveal older ones in batches: a long conversation
  // would otherwise lay out every bubble at once, and the whole app waits for it.
  // The window is pinned to message ids, so new arrivals and older pages never shift it. `last`
  // is null while the window reaches the newest message; it is set only after a jump far back,
  // so that one jump does not lay out everything between the target and now.
  const [range, setRange] = useState<{ first: string | null; last: string | null }>({
    first: null,
    last: null,
  });
  const anchorIndex = range.first ? messages.findIndex((msg) => msg.id === range.first) : -1;
  const lastIndex = range.last ? messages.findIndex((msg) => msg.id === range.last) : -1;
  const detached = lastIndex >= 0 && lastIndex < messages.length - 1;
  const newestBatch = Math.max(0, messages.length - RENDER_BATCH);
  // The newest batch always shows, even when history lands before the pinned message.
  const start = detached
    ? Math.max(0, anchorIndex)
    : anchorIndex >= 0
      ? Math.min(anchorIndex, newestBatch)
      : newestBatch;
  const end = detached ? lastIndex + 1 : messages.length;
  const shown = start > 0 || end < messages.length ? messages.slice(start, end) : messages;
  // Pin the window, and move it to a message someone jumps to. Both adjust state during
  // render, before anything paints.
  const jumpIndex = jumpToMessageId ? messages.findIndex((msg) => msg.id === jumpToMessageId) : -1;
  const jumpHidden = jumpIndex >= 0 && (jumpIndex < start || jumpIndex >= end);
  const nextRange = jumpHidden
    ? {
        first: messages[Math.max(0, jumpIndex - 10)]!.id,
        last:
          newestBatch - jumpIndex > 2 * RENDER_BATCH
            ? messages[Math.min(messages.length - 1, jumpIndex + RENDER_BATCH)]!.id
            : null,
      }
    : !detached && (anchorIndex < 0 || anchorIndex > start) && messages.length > 0
      ? { first: messages[start]!.id, last: null }
      : null;
  if (nextRange && (nextRange.first !== range.first || nextRange.last !== range.last))
    setRange(nextRange);
  const loadedIds = useMemo(() => new Set(messages.map((msg) => msg.id)), [messages]);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const timelineElement = () =>
    bottomRef.current?.closest<HTMLElement>('[data-conversation-timeline]') ?? null;
  /** Reveal up to `index`, keeping what is on screen where it is. */
  const revealFrom = (index: number) => {
    const target = messages[Math.max(0, index)];
    if (!target || target.id === range.first) return;
    const container = timelineElement();
    scrollAnchor.current = container
      ? { height: container.scrollHeight, top: container.scrollTop }
      : null;
    setRange((current) => ({ ...current, first: target.id }));
  };
  const showEarlier = () => {
    if (start > 0) revealFrom(start - RENDER_BATCH);
    else if (hasOlderHistory && !historyLoading) onLoadOlderHistory?.();
  };
  useLayoutEffect(() => {
    const saved = scrollAnchor.current;
    const container = timelineElement();
    scrollAnchor.current = null;
    if (saved && container) container.scrollTop = saved.top + container.scrollHeight - saved.height;
  }, [start]);
  const showEarlierRef = useRef(showEarlier);
  useLayoutEffect(() => {
    showEarlierRef.current = showEarlier;
  });
  // Opening a conversation lands on its newest message at once. Until then the top of the list
  // is briefly in view, and the reveal sentinel must not take that as the reader scrolling up.
  const landed = useRef(false);
  const [nearBottom, setNearBottom] = useState(true);
  const nearBottomRef = useRef(true);
  useLayoutEffect(() => {
    if (landed.current || messages.length === 0) return;
    const container = timelineElement();
    if (container) container.scrollTop = container.scrollHeight;
    landed.current = true;
  });
  useEffect(() => {
    const container = timelineElement();
    if (!container) return;
    const track = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
      nearBottomRef.current = near;
      setNearBottom(near);
    };
    container.addEventListener('scroll', track, { passive: true });
    return () => container.removeEventListener('scroll', track);
  }, []);
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !landed.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showEarlierRef.current();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [start]);
  const callbacks = useRef({ onRecallMessage, onRetryMessage, onDiscardMessage });
  useLayoutEffect(() => {
    callbacks.current = { onRecallMessage, onRetryMessage, onDiscardMessage };
  });
  const actions = useMemo<ChatMessageActions>(
    () => ({
      reply: (msg) => {
        setReplyTo({
          id: msg.id,
          senderId: msg.senderId,
          senderName: msg.senderName,
          text: msg.text.slice(0, 500) || (msg.media?.kind === 'image' ? '[图片]' : '[语音]'),
        });
        inputRef.current?.focus();
      },
      recall: (id) => callbacks.current.onRecallMessage?.(id),
      retry: (id) => {
        callbacks.current.onRetryMessage?.(id);
      },
      discard: (id) => callbacks.current.onDiscardMessage?.(id),
      openImage: (src) => setLightbox(src),
      jumpTo: (id) => {
        const source = messageElements.current.get(id);
        source?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        source?.focus({ preventScroll: true });
      },
      register: (id, element) => {
        if (element) messageElements.current.set(id, element);
        else messageElements.current.delete(id);
      },
    }),
    [],
  );

  const timeline = adaptHumanChatTimeline({
    conversationId,
    messages,
    mediaAccess: privateMediaToken === undefined ? 'room_authorized_url' : 'socket_capability',
    mediaConnected: privateMediaToken !== null,
  });
  const sequence = conversationSequence(
    messages.map((msg) => ({
      sender: msg.senderId === 'system' ? null : msg.senderId,
      at: msg.timestamp,
    })),
  );
  const arrivals = useConversationArrivals(messages.map((msg) => msg.id));
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);
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

  useEffect(() => {
    if (!jumpToMessageId) return;
    // Still hidden: the render that reveals it runs this again.
    if (jumpHidden) return;
    const element = messageElements.current.get(jumpToMessageId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.focus({ preventScroll: true });
      element.animate?.(
        [{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }],
        { duration: 1600 },
      );
      onJumpSettled?.(true);
    } else if (!hasOlderHistory || !onLoadOlderHistory) onJumpSettled?.(false);
    else if (!historyLoading) onLoadOlderHistory();
  }, [
    jumpToMessageId,
    messages,
    jumpHidden,
    hasOlderHistory,
    historyLoading,
    onLoadOlderHistory,
    onJumpSettled,
  ]);

  const latestMessageId = timeline.at(-1)?.itemId;
  const latestFromSelf = messages.at(-1)?.fromSelf === true;
  const [unseenNewer, setUnseenNewer] = useState(false);
  useEffect(() => {
    if (!latestMessageId) return;
    // Follow new messages only for a reader at the bottom, or for one's own message; someone
    // reading back is not pulled away, and sees a pill instead.
    if (!detached && (nearBottomRef.current || latestFromSelf)) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnseenNewer(false);
    } else setUnseenNewer(true);
    // `detached` is read for this arrival only; leaving it out keeps a jump from scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestMessageId, latestFromSelf]);
  const showUnseen = unseenNewer && (!nearBottom || detached);
  /** Back to the newest messages, straight there. */
  const toNewest = () => {
    landed.current = false;
    setRange({ first: null, last: null });
    setUnseenNewer(false);
  };
  const showLater = () => {
    const next = lastIndex + RENDER_BATCH;
    setRange((current) => ({
      ...current,
      last: next >= messages.length - 1 ? null : messages[next]!.id,
    }));
  };

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
      const explained = explainMediaFailure('microphone', err);
      if (explained instanceof MediaPermissionDeniedError) {
        setMediaError(explained.message, canOpenAppSettings());
      } else {
        setMediaError('无法访问麦克风，请检查权限设置');
      }
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
        {(start > 0 || hasOlderHistory) && (
          <button
            type="button"
            disabled={start === 0 && historyLoading}
            onClick={showEarlier}
            className="ui-press mx-auto rounded-full px-4 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)] disabled:opacity-60"
          >
            {start === 0 && historyLoading ? '读取中…' : '加载更早的消息'}
          </button>
        )}
        {readError && (
          <p role="status" className="px-3 text-xs text-[var(--text-faint)]">
            {readError}
          </p>
        )}
        {messages.length === 0 && <ConversationEmpty />}

        {start > 0 && <div ref={topSentinelRef} aria-hidden className="h-px shrink-0" />}
        {shown.map((msg, offset) => {
          const idx = start + offset;
          const position = sequence[idx]!;
          return (
            <ChatMessageItem
              key={msg.id}
              msg={msg}
              status={timeline[idx]!.status}
              showTime={position.showTime}
              continued={position.continued}
              groupEnd={position.groupEnd}
              arrived={arrivals.has(msg.id)}
              recallable={
                !!onRecallMessage &&
                msg.fromSelf &&
                msg.serverConfirmed === true &&
                now - msg.timestamp <= RECALL_WINDOW_MS
              }
              username={usernameByPeer.get(msg.senderId)}
              hint={hintByPeer.get(msg.senderId)}
              mentionsSelf={Boolean(selfId && msg.mentions?.some((m) => m.peerId === selfId))}
              privateMediaToken={privateMediaToken}
              replyDisabled={busy || !!recorder || !!pendingMedia}
              replySourceLoaded={!!msg.replyTo && loadedIds.has(msg.replyTo.id)}
              actions={actions}
            />
          );
        })}
        {detached && (
          <div className="flex justify-center gap-2 py-2">
            <button
              type="button"
              onClick={showLater}
              className="ui-press rounded-full px-4 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
            >
              显示后面的消息
            </button>
            <button
              type="button"
              onClick={toNewest}
              className="ui-press rounded-full px-4 py-1.5 text-sm text-[var(--accent-text)] hover:bg-[var(--bg-soft)]"
            >
              回到最新消息
            </button>
          </div>
        )}
        <div ref={bottomRef} />
        {showUnseen && (
          <button
            type="button"
            onClick={() => {
              // Straight there: a smooth scroll across many screens is slow and stalls in a
              // background tab.
              if (detached) {
                toNewest();
                return;
              }
              const container = timelineElement();
              if (container) container.scrollTop = container.scrollHeight;
              setUnseenNewer(false);
            }}
            className="ui-press sticky bottom-2 mx-auto rounded-full bg-[var(--accent)] px-3 py-1 text-xs text-[var(--button-text)] shadow-[var(--shadow-panel)]"
          >
            有新消息
          </button>
        )}
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
                {m.hint && (
                  <span className="shrink-0 text-xs text-[var(--text-faint)]">{m.hint}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {mediaError && (
          <div
            role="alert"
            className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-1.5 text-sm text-[var(--danger)]"
          >
            <span className="min-w-0 flex-1">{mediaError}</span>
            {mediaErrorOpensSettings && (
              <button
                type="button"
                onClick={() => openAppSettings()}
                className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-2 py-0.5 text-xs text-[var(--text)] hover:bg-[var(--bg-strong)]"
              >
                去设置
              </button>
            )}
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
              className={conversationComposerButtonClass()}
              title="取消录音"
            >
              <X size={20} />
            </button>
            <div className="flex flex-1 items-center gap-2 text-sm text-[var(--danger)]">
              <span className="h-2 w-2 rounded-full bg-[var(--danger)] motion-safe:animate-pulse" />
              录音中 {formatDuration(recElapsed)}
            </div>
            <button
              type="button"
              onClick={stopRecAndPreview}
              aria-label="结束录音"
              className={conversationComposerButtonClass(true)}
              title="结束录音"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-1.5">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handlePickImage} />
            <div className="relative shrink-0" ref={moreRef}>
              <button
                type="button"
                onClick={() => setMoreOpen((open) => !open)}
                aria-label="更多"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                disabled={busy || !!pendingMedia}
                className={conversationComposerButtonClass()}
              >
                <Plus size={24} />
              </button>
              {moreOpen && (
                <div
                  role="menu"
                  aria-label="发送内容"
                  className="ui-menu-in absolute bottom-full left-0 z-[var(--z-local-popover)] mb-2 w-44 rounded-xl border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-1 shadow-lg"
                  style={{ transformOrigin: 'bottom left' }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || !!pendingMedia}
                    onClick={() => {
                      setMoreOpen(false);
                      fileRef.current?.click();
                    }}
                    className="ui-press-row flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)] disabled:opacity-50"
                  >
                    <ImageIcon size={16} />
                    发送图片
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!!replyTo}
                    onClick={() => {
                      setMoreOpen(false);
                      setSharingCharacter(true);
                    }}
                    className="ui-press-row flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-soft)] disabled:opacity-50"
                  >
                    <UserRound size={16} />
                    分享公开角色
                  </button>
                </div>
              )}
            </div>
            <ConversationInput
              ref={inputRef}
              value={draft}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMentionQuery(null);
                else if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229
                ) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              // Typing stays open while media uploads; sending waits for it.
              placeholder={busy ? '发送中…' : '输入消息…'}
            />
            {draft.trim() ? (
              <button
                type="button"
                onClick={handleSend}
                aria-label="发送消息"
                disabled={busy || !!pendingMedia}
                className={conversationComposerButtonClass(true)}
              >
                <ArrowUp size={20} />
              </button>
            ) : (
              <button
                type="button"
                onClick={startRec}
                aria-label="发送语音"
                disabled={busy || !!pendingMedia}
                className={conversationComposerButtonClass()}
                title="发送语音"
              >
                <Mic size={22} />
              </button>
            )}
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
