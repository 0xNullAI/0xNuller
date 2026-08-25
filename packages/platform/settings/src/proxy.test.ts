import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROXY,
  applyHttpProxy,
  applyWebSocketProxy,
  isValidHttpProxyBaseUrl,
  loadProxy,
  saveProxy,
} from './proxy';

beforeEach(() => localStorage.clear());

describe('代理设置', () => {
  it('默认不启用', () => {
    expect(loadProxy()).toEqual(DEFAULT_PROXY);
  });

  it('存储被污染时按直连处理', () => {
    localStorage.setItem('0xnullai.proxy', '{不是 JSON');
    // Failing this way never sends requests somewhere unexpected.
    expect(loadProxy().enabled).toBe(false);
  });

  it('只接受完整的 HTTP 或 HTTPS 代理地址', () => {
    expect(isValidHttpProxyBaseUrl('https://proxy.example/path')).toBe(true);
    expect(isValidHttpProxyBaseUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isValidHttpProxyBaseUrl('proxy.example')).toBe(false);
    expect(isValidHttpProxyBaseUrl('socks5://127.0.0.1:1080')).toBe(false);
  });

  describe('HTTP 反代地址改写', () => {
    it('未启用时原样返回', () => {
      saveProxy({ ...DEFAULT_PROXY, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat')).toBe('https://api.x.ai/v1/chat');
    });

    it('启用且配置了地址时改写', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat?a=1')).toBe(
        'http://127.0.0.1:8080/api.x.ai/v1/chat?a=1',
      );
    });

    it('反代地址带路径前缀时保留前缀', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080/proxy/' });
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('http://127.0.0.1:8080/proxy/api.x.ai/v1');
    });

    it('反代地址不合法时原样返回，不是拼出一个坏地址', () => {
      saveProxy({ enabled: true, httpBaseUrl: '这不是地址' });
      // A broken config should look like "proxy not used", never like
      // requests going to a mistyped destination — the latter makes the
      // user believe the proxy is working.
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('https://api.x.ai/v1');
    });

    it('手动写入非 HTTP 代理协议时保持直连', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'socks5://127.0.0.1:1080' });
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('https://api.x.ai/v1');
      expect(applyWebSocketProxy('wss://api.x.ai/v1/realtime')).toBe('wss://api.x.ai/v1/realtime');
    });

    it('上游地址不合法时也原样返回', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('not-a-url')).toBe('not-a-url');
    });
  });

  it('持久化失败时仍在当前会话应用新代理', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage unavailable', 'QuotaExceededError');
    });
    try {
      saveProxy({ enabled: true, httpBaseUrl: 'https://proxy.example' });
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('https://proxy.example/api.x.ai/v1');
    } finally {
      setItem.mockRestore();
      saveProxy(DEFAULT_PROXY);
      localStorage.clear();
    }
  });

  describe('实时语音连接改写', () => {
    it('HTTPS 反代地址对应安全 WebSocket', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'https://proxy.example/realtime/' });
      expect(applyWebSocketProxy('wss://api.x.ai/v1/realtime?model=grok')).toBe(
        'wss://proxy.example/realtime/api.x.ai/v1/realtime?model=grok',
      );
    });

    it('本地 HTTP 反代地址对应普通 WebSocket', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyWebSocketProxy('wss://open.bigmodel.cn/api/paas/v4/realtime')).toBe(
        'ws://127.0.0.1:8080/open.bigmodel.cn/api/paas/v4/realtime',
      );
    });
  });
});
