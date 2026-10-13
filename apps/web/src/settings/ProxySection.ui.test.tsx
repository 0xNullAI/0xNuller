// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProxySection } from './ProxySection';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  localStorage.clear();
});

function typeAddress(value: string) {
  fireEvent.change(screen.getByLabelText('反向代理地址'), { target: { value } });
}

it('accepts a plain http proxy on the web', () => {
  render(<ProxySection />);
  typeAddress('http://127.0.0.1:8080');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/安卓应用只能使用 https/)).toBeNull();
});

it('explains and rejects an http proxy in the Android shell', () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  render(<ProxySection />);
  expect(screen.getByText(/安卓应用只能使用 https 地址/)).toBeTruthy();

  typeAddress('http://127.0.0.1:8080');
  expect(screen.getByRole('alert').textContent).toBe('安卓应用只能使用 https:// 开头的代理地址');

  typeAddress('https://proxy.example.com');
  expect(screen.queryByRole('alert')).toBeNull();
});
