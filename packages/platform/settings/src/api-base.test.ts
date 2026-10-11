import { afterEach, expect, it, vi } from 'vitest';
import { publicPageUrl } from './api-base';
afterEach(() => vi.unstubAllGlobals());
// Native and local origins produce usable public invites with encoded
// parameters; web links retain the deployed website origin.
it.each([
  [
    'http://tauri.localhost/',
    '/chat',
    { room: 'room&other' },
    'https://0xnullai.com/chat?room=room%26other',
  ],
  [
    'http://tauri.localhost/',
    '/settings',
    { invite: 'abc' },
    'https://0xnullai.com/settings?invite=abc',
  ],
  [
    'https://www.0xnullai.com/settings',
    '/chat',
    { room: 'abc' },
    'https://www.0xnullai.com/chat?room=abc',
  ],
])(
  'from %s, publicPageUrl(%s) builds %j into the public link',
  (origin, path, params, expected) => {
    vi.stubGlobal('location', new URL(origin));
    expect(publicPageUrl(path, params)).toBe(expected);
  },
);
