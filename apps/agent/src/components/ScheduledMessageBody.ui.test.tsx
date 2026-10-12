// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ScheduledMessageBody } from './ChatPanel';

afterEach(cleanup);

it('shows the server kind line as a tag, not as the first words of the reply', () => {
  render(<ScheduledMessageBody content={'AI主动消息\n晚上好呀'} />);
  expect(screen.getByText('主动消息')).toBeTruthy();
  expect(screen.getByText('晚上好呀')).toBeTruthy();
  expect(screen.queryByText(/AI主动消息/)).toBeNull();
});

it('leaves ordinary replies unchanged', () => {
  render(<ScheduledMessageBody content={'你好\n第二行'} />);
  expect(screen.queryByText('主动消息')).toBeNull();
  expect(screen.getByText(/你好/)).toBeTruthy();
});
