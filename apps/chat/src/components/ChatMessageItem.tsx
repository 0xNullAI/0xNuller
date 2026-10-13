import { Fragment, memo } from 'react';
import { Reply, Undo2 } from 'lucide-react';
import {
  ConversationMessageRow,
  ConversationTimeSeparator,
  conversationBubbleClass,
} from '@0xnullai/ui';
import { requestProfileView } from '@0xnullai/auth';
import type { ChatMessage, ChatMention } from '../lib/protocol';
import { formatDuration } from '../lib/media';
import { publicCharacterLink } from '../lib/public-character-share';
import { ProfileAvatar } from './ProfileAvatar';

export function mediaSource(url: string, privateMediaToken?: string | null): string | null {
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

/** Stable for the life of a panel, so a row re-renders only when its own data changes. */
export interface ChatMessageActions {
  reply: (msg: ChatMessage) => void;
  recall?: (id: string) => void;
  retry?: (id: string) => void;
  discard?: (id: string) => void;
  openImage: (src: string) => void;
  jumpTo: (id: string) => void;
  register: (id: string, element: HTMLDivElement | null) => void;
}

/**
 * One message. Every prop is a plain value or a stable callback: room state changes many times a
 * second (device heartbeats, presence, typing in the composer), and a long conversation must not
 * re-render all of its bubbles for any of them.
 */
export const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  status,
  showTime,
  continued,
  groupEnd,
  arrived,
  recallable,
  username,
  hint,
  mentionsSelf,
  privateMediaToken,
  replyDisabled,
  replySourceLoaded,
  actions,
}: {
  msg: ChatMessage;
  status: string;
  showTime: boolean;
  continued: boolean;
  groupEnd: boolean;
  arrived: boolean;
  recallable: boolean;
  username: string | null | undefined;
  hint: string | undefined;
  mentionsSelf: boolean;
  privateMediaToken?: string | null;
  replyDisabled: boolean;
  replySourceLoaded: boolean;
  actions: ChatMessageActions;
}) {
  const isSelf = msg.fromSelf;
  const hasMedia = !!msg.media;
  const name = msg.senderName || msg.senderId.slice(0, 6);

  if (msg.recalled)
    return (
      <Fragment>
        {showTime && <ConversationTimeSeparator at={msg.timestamp} />}
        <p className="py-1 text-center text-[11px] text-[var(--text-faint)]">
          {isSelf ? '你撤回了一条消息' : `${msg.senderName || '对方'} 撤回了一条消息`}
        </p>
      </Fragment>
    );

  const media = msg.media ? mediaSource(msg.media.url, privateMediaToken) : null;
  return (
    <Fragment>
      {showTime && <ConversationTimeSeparator at={msg.timestamp} />}
      <ConversationMessageRow
        data-message-id={msg.id}
        tabIndex={-1}
        own={isSelf}
        continued={continued}
        groupEnd={groupEnd}
        arrived={arrived}
        avatar={isSelf ? undefined : <ProfileAvatar name={name} username={username} size={28} />}
        ref={(element) => actions.register(msg.id, element)}
      >
        {msg.replyTo && (
          <blockquote className="mb-1 rounded border-l-2 border-[var(--accent)] bg-[var(--bg-soft)] px-2 py-1 text-xs text-[var(--text-soft)]">
            {msg.replyTo.unavailable ? (
              '原消息已不可用'
            ) : (
              <button
                type="button"
                className="block w-full text-left"
                disabled={!replySourceLoaded}
                title={replySourceLoaded ? '定位原消息' : '加载更早消息后可定位'}
                aria-label={`定位 ${msg.replyTo.senderName} 的原消息`}
                onClick={() => actions.jumpTo(msg.replyTo!.id)}
              >
                <strong>{msg.replyTo.senderName}</strong>
                <span className="block line-clamp-3 whitespace-pre-wrap">{msg.replyTo.text}</span>
              </button>
            )}
          </blockquote>
        )}
        {!isSelf && !continued && (
          <div className="mb-0.5 flex min-w-0 items-center gap-1 px-1 text-xs text-[var(--text-faint)]">
            {username ? (
              <button
                type="button"
                className="truncate hover:text-[var(--accent)] hover:underline"
                onClick={() => requestProfileView(username)}
              >
                {name}
              </button>
            ) : (
              <span className="truncate">{name}</span>
            )}
            {hint && <span className="shrink-0">· {hint}</span>}
          </div>
        )}

        <div
          className={`flex min-w-0 max-w-full items-end gap-1 ${isSelf ? 'flex-row-reverse' : ''}`}
        >
          <div className={`flex min-w-0 flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
            {msg.media?.kind === 'image' && media ? (
              <button
                onClick={() => actions.openImage(media)}
                className="block overflow-hidden rounded-[18px] border border-[var(--surface-border)]"
              >
                <img
                  src={media}
                  alt="图片"
                  loading="lazy"
                  decoding="async"
                  width={msg.media.w}
                  height={msg.media.h}
                  className="h-auto max-h-60 max-w-full object-cover"
                />
              </button>
            ) : msg.media?.kind === 'audio' && media ? (
              <div className={conversationBubbleClass(isSelf, false, continued)}>
                <audio controls preload="none" src={media} className="max-w-[220px]" />
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

            {(!hasMedia || msg.text) && (
              <div
                className={
                  `${hasMedia ? 'mt-1 ' : ''}` +
                  conversationBubbleClass(isSelf, mentionsSelf, continued) +
                  ' whitespace-pre-wrap'
                }
              >
                {renderMessageText(msg.text, msg.mentions, isSelf)}
              </div>
            )}
          </div>
          {msg.senderId !== 'system' && (
            <button
              type="button"
              aria-label={`回复 ${msg.senderName || '消息'}`}
              title="回复此消息"
              disabled={replyDisabled}
              className="ui-press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-faint)] opacity-60 hover:bg-[var(--bg-soft)] hover:opacity-100 disabled:opacity-30"
              onClick={() => actions.reply(msg)}
            >
              <Reply size={14} />
            </button>
          )}
          {recallable && actions.recall && (
            <button
              type="button"
              aria-label="撤回这条消息"
              title="撤回（发送后 2 分钟内）"
              className="ui-press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-faint)] opacity-60 hover:bg-[var(--bg-soft)] hover:opacity-100"
              onClick={() => actions.recall?.(msg.id)}
            >
              <Undo2 size={14} />
            </button>
          )}
        </div>
        {status === 'pending' && isSelf && (
          <p className="mt-0.5 px-1 text-[11px] text-[var(--text-faint)]">发送中…</p>
        )}
        {status === 'failed' && isSelf && (
          <p role="alert" className="mt-0.5 px-1 text-right text-[11px] text-[var(--danger)]">
            发送失败
            {actions.retry && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => actions.retry?.(msg.id)}
              >
                重试
              </button>
            )}
            {actions.discard && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => actions.discard?.(msg.id)}
              >
                放弃
              </button>
            )}
          </p>
        )}
      </ConversationMessageRow>
    </Fragment>
  );
});
