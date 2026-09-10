import { afterEach, expect, it, vi } from 'vitest';
import { publicPageUrl } from './api-base';
afterEach(() => vi.unstubAllGlobals());
it('native and local origins produce usable public invites with encoded parameters', () => {
  vi.stubGlobal('location', new URL('http://tauri.localhost/'));
  expect(publicPageUrl('/chat', { room: 'room&other' })).toBe(
    'https://0xnullai.com/chat?room=room%26other',
  );
  expect(publicPageUrl('/settings', { invite: 'abc' })).toBe(
    'https://0xnullai.com/settings?invite=abc',
  );
});
it('web links retain the deployed website origin and use the correct module route', () => {
  vi.stubGlobal('location', new URL('https://www.0xnullai.com/settings'));
  expect(publicPageUrl('/chat', { room: 'abc' })).toBe('https://www.0xnullai.com/chat?room=abc');
});
