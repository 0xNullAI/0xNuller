import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROXY, applyHttpProxy, loadProxy, saveProxy, socksSupported } from './proxy';

beforeEach(() => localStorage.clear());

describe('代理设置', () => {
  it('默认不启用', () => {
    expect(loadProxy()).toEqual(DEFAULT_PROXY);
  });

  it('存储被污染时按直连处理', () => {
    localStorage.setItem('0xnullai.proxy', '{不是 JSON');
    // 这个方向的失败不会把请求发到意料之外的地方。
    expect(loadProxy().enabled).toBe(false);
  });

  describe('HTTP 反代地址改写', () => {
    it('未启用时原样返回', () => {
      saveProxy({ ...DEFAULT_PROXY, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat')).toBe('https://api.x.ai/v1/chat');
    });

    it('启用且配置了地址时改写', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080', socksUrl: '' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat?a=1')).toBe(
        'http://127.0.0.1:8080/api.x.ai/v1/chat?a=1',
      );
    });

    it('反代地址带路径前缀时保留前缀', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080/proxy/', socksUrl: '' });
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('http://127.0.0.1:8080/proxy/api.x.ai/v1');
    });

    it('反代地址不合法时原样返回，不是拼出一个坏地址', () => {
      saveProxy({ enabled: true, httpBaseUrl: '这不是地址', socksUrl: '' });
      // 配置错了应该表现为「没走代理」，而不是把请求发到一个拼错的地方——
      // 后者会让用户以为代理在工作。
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('https://api.x.ai/v1');
    });

    it('上游地址不合法时也原样返回', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080', socksUrl: '' });
      expect(applyHttpProxy('not-a-url')).toBe('not-a-url');
    });
  });

  it('SOCKS 只在 Tauri 壳里可用', () => {
    // 浏览器不允许页面自行选择代理——那是 OS/浏览器层的设置。给网页端一个 SOCKS
    // 开关等于给一个看起来能用、实际永不生效的按钮。
    expect(socksSupported('web')).toBe(false);
    expect(socksSupported('tauri')).toBe(true);
  });
});
