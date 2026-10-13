// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MarkdownText } from './MarkdownText';

afterEach(cleanup);

it('shows the text at once and renders markdown when the renderer arrives', async () => {
  render(<MarkdownText content={'你好 **世界**'} />);
  // First paint does not wait for the markdown bundle.
  expect(screen.getByText('你好 **世界**')).toBeTruthy();
  const strong = await screen.findByText('世界');
  expect(strong.tagName).toBe('STRONG');
});
