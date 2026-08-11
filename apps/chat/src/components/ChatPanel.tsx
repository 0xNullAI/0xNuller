import { Overlay } from '@0xnullai/ui';
import { requestProfileView } from '@0xnullai/auth';
import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Image as ImageIcon, Mic, X, AtSign } from 'lucide-react';
import type { ChatMessage, ChatMention } from '../lib/protocol';
import { compressImage, startRecording, formatDuration, type Recorder } from '../lib/media';
import { ProfileAvatar } from './ProfileAvatar';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string, mentions?: ChatMention[]) => void;
  /** Upload and send media (image/voice). The caller should ignore this while the room is not ready. */
  onSendMedia: (
    blob: Blob,
    kind: 'image' | 'audio',
    meta?: { durationMs?: number; w?: number; h?: number },
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

export function ChatPanel({ messages, onSend, onSendMedia, members = [], selfId }: ChatPanelProps) {
  // Sender id to account handle. Rebuilt per render from a list that is at most
  // a roomful long, which is cheaper than the memo that would guard it.
  const usernameByPeer = new Map(members.map((m) => [m.peerId, m.username ?? null]));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recElapsed, setRecElapsed] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const pendingMentionsRef = useRef<ChatMention[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recStartRef = useRef(0);

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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Recording timer: the start time lives in a ref, the interval computes elapsed duration from it.
  useEffect(() => {
    if (!recorder) return;
    const t = window.setInterval(() => setRecElapsed(Date.now() - recStartRef.current), 250);
    return () => clearInterval(t);
  }, [recorder]);

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    // Keep only the @ mentions that still appear in the text.
    const mentions = pendingMentionsRef.current.filter((m) => text.includes(`@${m.displayName}`));
    onSend(text, mentions.length ? mentions : undefined);
    setDraft('');
    pendingMentionsRef.current = [];
    setMentionQuery(null);
  }

  async function handlePickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setMediaError(null);
    try {
      const { blob, w, h } = await compressImage(file);
      await onSendMedia(blob, 'image', { w, h });
    } catch (err) {
      console.error('[Chat] image send failed', err);
      setMediaError('图片发送失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function startRec() {
    setMediaError(null);
    try {
      const rec = await startRecording();
      recStartRef.current = Date.now();
      setRecElapsed(0);
      setRecorder(rec);
    } catch (err) {
      console.error('[Chat] mic access failed', err);
      setMediaError('无法访问麦克风，请检查权限设置');
    }
  }

  async function stopRecAndSend() {
    if (!recorder) return;
    const rec = recorder;
    setRecorder(null);
    setBusy(true);
    try {
      const { blob, durationMs } = await rec.stop();
      if (blob.size > 0) await onSendMedia(blob, 'audio', { durationMs });
    } catch (err) {
      console.error('[Chat] voice send failed', err);
      setMediaError('语音发送失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function cancelRec() {
    recorder?.cancel();
    setRecorder(null);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="mt-16 flex flex-col items-center gap-2 text-[var(--text-faint)]">
            <span className="text-3xl">💬</span>
            <p className="text-sm">暂无消息</p>
            <p className="text-xs">发一条消息开始聊天</p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isSelf = msg.fromSelf;
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const sameSender = prevMsg?.senderId === msg.senderId;
          const closeInTime = prevMsg && msg.timestamp - prevMsg.timestamp < 60000;
          const grouped = sameSender && closeInTime;
          const hasMedia = !!msg.media;

          return (
            <div
              key={msg.id}
              className={`${grouped ? 'mb-0.5' : 'mb-2'} flex animate-msg-in gap-2 ${isSelf ? 'justify-end' : 'justify-start'}`}
            >
              {/* A fixed-width gutter, so grouped messages stay aligned with
                  the first one in the run instead of sliding left. */}
              {!isSelf && (
                <div className="w-7 shrink-0">
                  {!grouped && (
                    <ProfileAvatar
                      name={msg.senderName || msg.senderId.slice(0, 6)}
                      username={usernameByPeer.get(msg.senderId)}
                      size={28}
                    />
                  )}
                </div>
              )}
              <div className="max-w-[75%]">
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

                {msg.media?.kind === 'image' ? (
                  <button
                    onClick={() => setLightbox(msg.media!.url)}
                    className="block overflow-hidden rounded-[var(--radius-md)] border border-[var(--surface-border)]"
                  >
                    <img
                      src={msg.media.url}
                      alt="图片"
                      loading="lazy"
                      className="max-h-60 max-w-full object-cover"
                    />
                  </button>
                ) : msg.media?.kind === 'audio' ? (
                  <div
                    className={
                      isSelf
                        ? 'rounded-[var(--radius-md)] rounded-br-[var(--radius-2xs)] bg-[var(--accent)] px-3 py-2'
                        : 'rounded-[var(--radius-md)] rounded-bl-[var(--radius-2xs)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2'
                    }
                  >
                    <audio controls src={msg.media.url} className="max-w-[220px]" />
                    {msg.media.durationMs != null && (
                      <p
                        className={`mt-0.5 text-[10px] ${isSelf ? 'text-[var(--button-text)]' : 'text-[var(--text-faint)]'}`}
                      >
                        语音 {formatDuration(msg.media.durationMs)}
                      </p>
                    )}
                  </div>
                ) : null}

                {(!hasMedia || msg.text) && (
                  <div
                    className={
                      `${hasMedia ? 'mt-1 ' : ''}` +
                      (isSelf
                        ? 'rounded-[var(--radius-md)] rounded-br-[var(--radius-2xs)] bg-[var(--accent)] px-3 py-2 text-sm text-[var(--button-text)]'
                        : 'rounded-[var(--radius-md)] rounded-bl-[var(--radius-2xs)] border px-3 py-2 text-sm text-[var(--text)] ' +
                          (selfId && msg.mentions?.some((m) => m.peerId === selfId)
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--surface-border)] bg-[var(--bg-elevated)]'))
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
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div className="relative border-t border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2">
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
              onClick={stopRecAndSend}
              aria-label="结束录音并发送"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90"
              title="结束并发送"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handlePickImage} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="发送图片"
              disabled={busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
              title="发送图片"
            >
              <ImageIcon size={20} />
            </button>
            <button
              type="button"
              onClick={startRec}
              aria-label="发送语音"
              disabled={busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
              title="发送语音"
            >
              <Mic size={20} />
            </button>
            <input
              type="text"
              value={draft}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMentionQuery(null);
                else if (e.key === 'Enter') handleSend();
              }}
              placeholder={busy ? '发送中…' : '输入消息…'}
              disabled={busy}
              className="flex-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-60"
              style={{ fontSize: '16px' }}
            />
            <button
              type="button"
              onClick={handleSend}
              aria-label="发送消息"
              disabled={!draft.trim() || busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        )}
      </div>

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
