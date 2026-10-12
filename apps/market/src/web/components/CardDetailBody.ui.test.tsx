// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CardDetailBody } from './CardDetailBody';

afterEach(cleanup);

const card = {
  schemaVersion: 1 as const,
  description: '人物'.repeat(120),
  personality: '话少。',
  greeting: '（敲了两下门）先吃药。',
  exampleDialogue: '你：你怎么还没睡？\n霍聿深：在写补充条款。',
  tags: [],
  creator: 'Foreverse 团队',
  license: 'CC BY 4.0',
};

it('reads as one column: opening bubble, folded long text, chat-style examples, quiet credit', () => {
  render(<CardDetailBody card={card} prompt="完整的设定原文" isCharacter />);
  expect(screen.getByRole('region', { name: '开场' }).textContent).toContain('先吃药');
  const person = screen.getByRole('region', { name: '人物' });
  fireEvent.click(person.querySelector('button')!);
  expect(person.textContent).toContain('收起');
  // Short sections have nothing to unfold.
  expect(screen.getByRole('region', { name: '性格与说话方式' }).querySelector('button')).toBeNull();
  const bubbles = screen.getByRole('region', { name: '对话示例' }).querySelectorAll('.card-bubble');
  expect([...bubbles].map((b) => b.className.includes('card-bubble-self'))).toEqual([true, false]);
  expect(bubbles[1]!.textContent).toBe('在写补充条款。');
  expect(screen.getByText('完整设定')).toBeTruthy();
  expect(screen.getByText(/原作者：Foreverse 团队/)).toBeTruthy();
});

it('shows a scene as its setting text', () => {
  render(<CardDetailBody card={undefined} prompt="雨夜车站" isCharacter={false} />);
  expect(screen.getByRole('region', { name: '场景设定' }).textContent).toContain('雨夜车站');
});
