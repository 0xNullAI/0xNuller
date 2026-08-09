import { afterEach, describe, expect, it } from 'vitest';
import { apiBaseUrl, apiWsUrl } from './api-base.js';

/**
 * The web build and the Tauri shell disagree about what "same-origin"
 * means, and the difference only surfaces once installed on a phone. These
 * tests are the only way to catch it before packaging.
 */

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function asTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

describe('接口基地址', () => {
  it('网页端为空串——同源相对路径跟着当前部署走', () => {
    expect(apiBaseUrl()).toBe('');
  });

  it('Tauri 壳返回绝对 origin', () => {
    asTauri();
    // An empty string here sends requests to the WebView's own asset
    // server, which returns index.html; the resulting JSON.parse error has
    // nothing to do with the real cause.
    expect(apiBaseUrl()).toBe('https://0xnullai.com');
  });

  it('WebSocket 网页端跟随页面协议', () => {
    // jsdom defaults to http://localhost
    expect(apiWsUrl('/api/realtime')).toBe(`ws://${location.host}/api/realtime`);
  });

  it('WebSocket 在 Tauri 壳里用 wss 绝对地址', () => {
    asTauri();
    // Not `wss://tauri.localhost/...` — that shape actually shipped once.
    expect(apiWsUrl('/api/realtime')).toBe('wss://0xnullai.com/api/realtime');
  });

  it('拼接不产生双斜杠', () => {
    asTauri();
    expect(apiBaseUrl() + '/api/auth/me').toBe('https://0xnullai.com/api/auth/me');
  });
});
