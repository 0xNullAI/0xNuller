import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AboutTab } from '../settings/AboutTab';

afterEach(cleanup);

it('关于页的「用户协议」打开应用内阅读器', async () => {
  render(<AboutTab />);
  fireEvent.click(screen.getByRole('button', { name: '用户协议' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('article', { name: '用户协议' }).textContent).toContain(
    '不是医疗器械',
  );
});
