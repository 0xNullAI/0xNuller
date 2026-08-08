import { afterEach, describe, expect, it } from 'vitest';
import { apiBaseUrl, apiWsUrl } from './api-base.js';

/**
 * 网页端与 Tauri 壳对「同源」的理解不一样，而这个差异只有装到手机上才会暴露。
 * 这些测试是在打包之前把它拦下来的唯一手段。
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
    // 空串在这里会让请求打到 WebView 自己的资源服务上，返回 index.html，
    // 前端拿去 JSON.parse 报的错跟真正的原因毫无关系。
    expect(apiBaseUrl()).toBe('https://0xnullai.com');
  });

  it('WebSocket 网页端跟随页面协议', () => {
    // jsdom 默认是 http://localhost
    expect(apiWsUrl('/api/realtime')).toBe(`ws://${location.host}/api/realtime`);
  });

  it('WebSocket 在 Tauri 壳里用 wss 绝对地址', () => {
    asTauri();
    // 不是 `wss://tauri.localhost/...`——那是曾经真实发生过的形态。
    expect(apiWsUrl('/api/realtime')).toBe('wss://0xnullai.com/api/realtime');
  });

  it('拼接不产生双斜杠', () => {
    asTauri();
    expect(apiBaseUrl() + '/api/auth/me').toBe('https://0xnullai.com/api/auth/me');
  });
});
