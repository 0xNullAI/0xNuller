import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Image as ImageIcon, Mic, X, AtSign } from 'lucide-react';
import type { ChatMessage, ChatMention } from '../lib/protocol';
import { compressImage, startRecording, formatDuration, type Recorder } from '../lib/media';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string, mentions?: ChatMention[]) => void;
  /** 上传并发送媒体（图片/语音）。房间未就绪时上层应忽略。 */
  onSendMedia: (blob: Blob, kind: 'image' | 'audio', meta?: { durationMs?: number; w?: number; h?: number }) => Promise<void>;
  /** 可 @ 提及的成员（其他成员 + 自己）。 */
  members?: { peerId: string; name: string }[];
  /** 自己的 peerId（用于「@到我」高亮）。 */
  selfId?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把文本里的 @角色名/昵称高亮。自己气泡是 accent 底色，@ 改用下划线+加粗以保证可读。 */
function renderMessageText(text: string, mentions?: ChatMention[], isSelf = false): React.ReactNode {
  const names = (mentions ?? []).map(m => m.displayName).filter(Boolean);
  if (names.length === 0) return text;
  const re = new RegExp(`(@(?:${names.map(escapeRegExp).join('|')}))`, 'g');
  const cls = isSelf ? 'font-semibold underline underline-offset-2' : 'font-medium text-[var(--accent)]';
  return text.split(re).map((part, i) =>
    part.startsWith('@') && names.includes(part.slice(1))
      ? <span key={i} className={cls}>{part}</span>
      : part,
  );
}

export function ChatPanel({ messages, onSend, onSendMedia, members = [], selfId }: ChatPanelProps) {
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

  const mentionCandidates = mentionQuery !== null
    ? members.filter(m => m.name && m.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
    : [];

  function handleInputChange(value: string) {
    setDraft(value);
    const m = /@([^\s@]*)$/.exec(value);
    setMentionQuery(m ? m[1] : null);
  }

  function selectMention(member: { peerId: string; name: string }) {
    setDraft(prev => prev.replace(/@([^\s@]*)$/, `@${member.name} `));
    if (!pendingMentionsRef.current.some(x => x.peerId === member.peerId)) {
      pendingMentionsRef.current.push({ peerId: member.peerId, displayName: member.name });
    }
    setMentionQuery(null);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 录音计时：开始时间记在 ref，interval 内计算已录时长。
  useEffect(() => {
    if (!recorder) return;
    const t = window.setInterval(() => setRecElapsed(Date.now() - recStartRef.current), 250);
    return () => clearInterval(t);
  }, [recorder]);

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    // 只保留文本里仍出现的 @ 提及。
    const mentions = pendingMentionsRef.current.filter(m => text.includes(`@${m.displayName}`));
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
      console.error('[DG-Chat] image send failed', err);
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
      console.error('[DG-Chat] mic access failed', err);
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
      console.error('[DG-Chat] voice send failed', err);
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
            <p className="text-sm">还没有消息</p>
            <p className="text-xs">发送第一条消息开始聊天吧</p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const isSelf = msg.fromSelf;
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const sameSender = prevMsg?.senderId === msg.senderId;
          const closeInTime = prevMsg && (msg.timestamp - prevMsg.timestamp) < 60000;
          const grouped = sameSender && closeInTime;
          const hasMedia = !!msg.media;

          return (
            <div
              key={msg.id}
              className={`${grouped ? 'mb-0.5' : 'mb-2'} flex animate-msg-in ${isSelf ? 'justify-end' : 'justify-start'}`}
            >
              <div className="max-w-[75%]">
                {!isSelf && !grouped && (
                  <p className="mb-0.5 flex items-center gap-1 px-1 text-xs text-[var(--text-faint)]">
                    <span className="truncate">{msg.senderName || msg.senderId.slice(0, 6)}</span>
                    {msg.senderRole && (
                      <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                        {msg.senderRole}
                      </span>
                    )}
                  </p>
                )}

                {msg.media?.kind === 'image' ? (
                  <button
                    onClick={() => setLightbox(msg.media!.url)}
                    className="block overflow-hidden rounded-[14px] border border-[var(--surface-border)]"
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
                        ? 'rounded-[14px] rounded-br-[4px] bg-[var(--accent)] px-3 py-2'
                        : 'rounded-[14px] rounded-bl-[4px] border border-[var(--surface-border)] bg-[var(--bg-elevated)] px-3 py-2'
                    }
                  >
                    <audio controls src={msg.media.url} className="max-w-[220px]" />
                    {msg.media.durationMs != null && (
                      <p className={`mt-0.5 text-[10px] ${isSelf ? 'text-[var(--button-text)]' : 'text-[var(--text-faint)]'}`}>
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
                        ? 'rounded-[14px] rounded-br-[4px] bg-[var(--accent)] px-3 py-2 text-sm text-[var(--button-text)]'
                        : 'rounded-[14px] rounded-bl-[4px] border px-3 py-2 text-sm text-[var(--text)] ' +
                          (selfId && msg.mentions?.some(m => m.peerId === selfId)
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
        {/* @ 提及候选 */}
        {mentionCandidates.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 max-h-44 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow)]">
            {mentionCandidates.map(m => (
              <button
                key={m.peerId}
                onMouseDown={e => { e.preventDefault(); selectMention(m); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--bg-soft)]"
              >
                <AtSign size={13} className="shrink-0 text-[var(--text-faint)]" />
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
        )}
        {mediaError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-1.5 text-sm text-[var(--danger)]">
            <span>{mediaError}</span>
            <button
              onClick={() => setMediaError(null)}
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
              onClick={cancelRec}
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
              onClick={stopRecAndSend}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90"
              title="结束并发送"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handlePickImage}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
              title="发送图片"
            >
              <ImageIcon size={20} />
            </button>
            <button
              onClick={startRec}
              disabled={busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:text-[var(--accent)] transition-colors disabled:opacity-40"
              title="发送语音"
            >
              <Mic size={20} />
            </button>
            <input
              type="text"
              value={draft}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setMentionQuery(null);
                else if (e.key === 'Enter') handleSend();
              }}
              placeholder={busy ? '发送中...' : '输入消息...'}
              disabled={busy}
              className="flex-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-60"
              style={{ fontSize: '16px' }}
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim() || busy}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        )}
      </div>

      {/* 图片放大 */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <img src={lightbox} alt="图片" className="max-h-full max-w-full rounded-[var(--radius-sm)]" />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white"
          >
            <X size={22} />
          </button>
        </div>
      )}
    </div>
  );
}
