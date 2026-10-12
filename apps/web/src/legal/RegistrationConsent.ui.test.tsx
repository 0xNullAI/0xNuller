import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as AuthModule from '@0xnullai/auth';
import type { AuthUser } from '@0xnullai/auth';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';
import { AccountContent } from '../settings/AccountContent';

const auth = vi.hoisted(() => ({
  register: vi.fn(() =>
    Promise.resolve({
      id: 'u1',
      username: 'alice',
      displayName: 'alice',
      emailVerified: false,
    } as AuthUser),
  ),
}));

vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  ...auth,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CONSENT = '我已年满 18 岁，并阅读同意《用户协议》';

function openRegistration() {
  render(<AccountContent user={null} onUser={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '没有账户？注册' }));
  fireEvent.change(screen.getByPlaceholderText('3–24 位字母、数字、下划线'), {
    target: { value: 'alice' },
  });
  fireEvent.change(screen.getByPlaceholderText('name@example.com'), {
    target: { value: 'alice@example.com' },
  });
  fireEvent.change(screen.getByPlaceholderText('至少 8 位'), {
    target: { value: 'correct-horse-battery' },
  });
}

it('注册按钮在勾选年龄与协议同意前保持禁用，同意后提交当前协议版本', async () => {
  openRegistration();
  const submit = screen.getByRole('button', { name: '注册' }) as HTMLButtonElement;
  const consent = screen.getByRole('checkbox', { name: CONSENT });
  expect(submit.disabled).toBe(true);

  fireEvent.click(consent);
  expect(submit.disabled).toBe(false);
  fireEvent.click(consent);
  expect(submit.disabled).toBe(true);

  fireEvent.click(consent);
  fireEvent.click(submit);
  await waitFor(() => expect(auth.register).toHaveBeenCalledOnce());
  expect(auth.register).toHaveBeenCalledWith(
    expect.objectContaining({ username: 'alice', acceptedTerms: LEGAL_TERMS_VERSION }),
  );
});

it('协议链接指向公开地址，点击后在应用内打开且保留已填写的表单', async () => {
  openRegistration();
  const terms = screen.getByRole('link', { name: '《用户协议》' });
  expect(terms.getAttribute('href')).toBe('/legal/terms');
  expect(screen.queryByRole('link', { name: '《隐私政策》' })).toBeNull();

  fireEvent.click(terms);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: '用户协议' })).toBeTruthy();
  expect(within(dialog).getByRole('article', { name: '用户协议' }).textContent).toContain(
    '不是医疗器械',
  );
  // Reading the text must not tick the box on the reader's behalf.
  // (The modal hides the form from the accessibility tree while it is open.)
  const consent = screen.getByRole('checkbox', { name: CONSENT, hidden: true });
  expect((consent as HTMLInputElement).checked).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect((screen.getByPlaceholderText('3–24 位字母、数字、下划线') as HTMLInputElement).value).toBe(
    'alice',
  );
});
