import { Fragment } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  ConversationMessageRow,
  ConversationTimeSeparator,
  ConversationTimeline,
  useConversationArrivals,
} from './conversation-layout';
import { conversationSequence, formatConversationTime } from './conversation-sequence';

afterEach(cleanup);

interface Message {
  id: string;
  sender: string;
  at: number;
}

const NOW = new Date(2026, 9, 11, 15, 0).getTime();
const minute = 60_000;

function Timeline({ messages }: { messages: Message[] }) {
  const sequence = conversationSequence(messages.map(({ sender, at }) => ({ sender, at })));
  const arrivals = useConversationArrivals(messages.map((message) => message.id));
  return (
    <ConversationTimeline>
      {messages.map((message, index) => {
        const position = sequence[index]!;
        return (
          <Fragment key={message.id}>
            {position.showTime && <ConversationTimeSeparator at={message.at} now={NOW} />}
            <ConversationMessageRow
              own={message.sender === 'me'}
              continued={position.continued}
              groupEnd={position.groupEnd}
              arrived={arrivals.has(message.id)}
              avatar={message.sender === 'me' ? undefined : <span title={`头像 ${message.id}`} />}
            >
              {message.id}
            </ConversationMessageRow>
          </Fragment>
        );
      })}
    </ConversationTimeline>
  );
}

function row(id: string) {
  return screen.getByText(id).closest('[data-conversation-message]')!;
}

const history: Message[] = [
  { id: 'a1', sender: 'ai', at: NOW - 30 * minute },
  { id: 'a2', sender: 'ai', at: NOW - 29 * minute },
  { id: 'm1', sender: 'me', at: NOW - 28 * minute },
  // Same sender, but 20 minutes later: a new time separator starts a new group.
  { id: 'm2', sender: 'me', at: NOW - 8 * minute },
];

it('shows a time only after a 5-minute gap and groups consecutive rows by sender', () => {
  render(<Timeline messages={history} />);

  const times = [...document.querySelectorAll('[data-conversation-time]')].map(
    (element) => element.textContent,
  );
  expect(times).toEqual(['14:30', '14:52']);

  expect(row('a1').hasAttribute('data-continued')).toBe(false);
  expect(row('a2').hasAttribute('data-continued')).toBe(true);
  expect(row('m1').hasAttribute('data-continued')).toBe(false);
  expect(row('m2').hasAttribute('data-continued')).toBe(false);
  // The avatar is drawn once, on the last row of the AI group.
  expect(screen.queryByTitle('头像 a1')).toBeNull();
  expect(screen.getByTitle('头像 a2')).toBeTruthy();
});

it('fades in only messages that arrive at the end, not the first list or older history', () => {
  const view = render(<Timeline messages={history} />);
  expect(document.querySelectorAll('.ui-fade-up')).toHaveLength(0);

  const older: Message = { id: 'old', sender: 'ai', at: NOW - 60 * minute };
  view.rerender(<Timeline messages={[older, ...history]} />);
  expect(document.querySelectorAll('.ui-fade-up')).toHaveLength(0);

  const reply: Message = { id: 'new', sender: 'ai', at: NOW - 7 * minute };
  view.rerender(<Timeline messages={[older, ...history, reply]} />);
  expect(row('new').classList.contains('ui-fade-up')).toBe(true);
  expect(row('m2').classList.contains('ui-fade-up')).toBe(false);

  // Another conversation: nothing overlaps, so nothing animates.
  view.rerender(<Timeline messages={[{ id: 'other', sender: 'ai', at: NOW }]} />);
  expect(document.querySelectorAll('.ui-fade-up')).toHaveLength(0);
});

it('names yesterday and older days in the separator', () => {
  expect(formatConversationTime(new Date(2026, 9, 10, 9, 5).getTime(), NOW)).toBe('昨天 09:05');
  expect(formatConversationTime(new Date(2026, 2, 2, 9, 5).getTime(), NOW)).toBe('3月2日 09:05');
  expect(formatConversationTime(new Date(2025, 2, 2, 9, 5).getTime(), NOW)).toBe(
    '2025年3月2日 09:05',
  );
});
